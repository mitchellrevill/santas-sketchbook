import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';

const config = { apiKey: 'sk-test-not-a-real-key', liveModel: 'gpt-live-1', imageModel: 'gpt-image-2' };
// Boundary fixture: a PNG header with the canvas dimensions. Browser tests use decoded images.
const bytes = Buffer.alloc(25); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
bytes.write('IHDR', 12); bytes.writeUInt32BE(1536, 16); bytes.writeUInt32BE(1024, 20);
const image = `data:image/png;base64,${bytes.toString('base64')}`;
const payload = { adultTest: true, image, notes: 'Golden runners', conversation: 'You: A red sleigh please.' };
const drawPayload = { adultTest: true, image, conversation: 'You: Draw a little man.', viewport: { width: 1440, height: 1000 }, pointer: { x: 500, y: 400 } };
const drawingPlan = { action: 'draw', message: 'A little man', strokes: [{ colour: '#353c3b', width: 4, points: [{ x: 500, y: 300 }, { x: 500, y: 450 }] }] };
const helperResponse = plan => Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'draw_on_canvas', arguments: JSON.stringify(plan) }] });

test('delegated helper receives the canvas and conversation and returns only validated strokes', async t => {
  let received;
  const { post } = await app(t, async (url, options) => { received = { url, ...JSON.parse(options.body) }; return helperResponse(drawingPlan); });
  const response = await post('/api/draw', drawPayload);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), drawingPlan);
  assert.equal(received.url, 'https://api.openai.com/v1/responses'); assert.equal(received.model, 'gpt-6-luna');
  assert.equal(received.store, false); assert.equal(received.tools[0].strict, true);
  assert.equal(received.input[0].content[1].image_url, image);
  assert.match(received.input[0].content[0].text, /Draw a little man/);
  assert.deepEqual(received.tool_choice, { type: 'function', name: 'draw_on_canvas' });
});

test('helper can request a photo or decline an unclear request without returning strokes', async t => {
  for (const action of ['convert', 'none', 'cancel']) {
    const plan = { action, message: 'The latest request', strokes: [] };
    const { post } = await app(t, async () => helperResponse(plan));
    const response = await post('/api/draw', drawPayload); assert.equal(response.status, 200); assert.deepEqual(await response.json(), plan);
  }
});

test('invalid delegated actions and coordinates are rejected before any drawing can execute', async t => {
  const invalid = [
    { ...drawingPlan, action: 'execute_code' }, { ...drawingPlan, action: 'convert' },
    { ...drawingPlan, strokes: [null] },
    { ...drawingPlan, strokes: [{ ...drawingPlan.strokes[0], points: [{ x: -1, y: 5 }, { x: 1, y: 5 }] }] },
    { ...drawingPlan, strokes: Array(33).fill(drawingPlan.strokes[0]) },
  ];
  for (const plan of invalid) {
    const { post } = await app(t, async () => helperResponse(plan));
    assert.equal((await post('/api/draw', drawPayload)).status, 502);
  }
});

test('drawing endpoint checks input and rejects overlapping paid requests', async t => {
  let complete, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { post } = await app(t, async () => { entered(); return new Promise(resolve => { complete = () => resolve(helperResponse(drawingPlan)); }); });
  assert.equal((await post('/api/draw', drawPayload, { 'X-Sketchbook-Token': 'bad' })).status, 403);
  assert.equal((await post('/api/draw', { ...drawPayload, pointer: {x: 1001, y: 5} })).status, 400);
  const first = post('/api/draw', drawPayload); await started;
  assert.equal((await post('/api/draw', drawPayload)).status, 429);
  assert.equal((await post('/api/convert', payload)).status, 429);
  complete(); assert.equal((await first).status, 200);
});

async function app(t, fetchImpl, overrides = {}) {
  const server = createApp({ getConfig: () => ({ ...config, ...overrides }), fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(`${origin}/api/config`).then(r => r.json());
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sketchbook-Token': setup.csrfToken, ...headers }, body: JSON.stringify(body) });
  return { origin, setup, post };
}

test('local config and static routes cannot expose the API key or .env', async t => {
  const { origin, setup } = await app(t, () => { throw Error('unexpected call'); });
  assert.equal(setup.configured, true); assert.ok(!JSON.stringify(setup).includes(config.apiKey));
  for (const path of ['/.env', '/lib/config.mjs', '/%2e%2e/.env']) assert.equal((await fetch(origin + path)).status, 404);
  const response = await fetch(origin); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('cross-origin, forged host and missing anti-forgery token are rejected before paid calls', async t => {
  let calls = 0; const { origin, post } = await app(t, () => { calls++; });
  assert.equal((await post('/api/convert', payload, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/convert', payload, { 'X-Sketchbook-Token': 'bad' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(origin + '/api/config', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(calls, 0);
});

test('adult-test gate and canvas limits prevent invalid submissions', async t => {
  let calls = 0; const { post } = await app(t, () => { calls++; });
  assert.equal((await post('/api/convert', { ...payload, adultTest: false })).status, 403);
  assert.equal((await post('/api/convert', { ...payload, image: 'https://example.com/image.png' })).status, 400);
  assert.equal((await post('/api/convert', { ...payload, notes: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post('/api/session', { adultTest: true, sdp: 'invalid' })).status, 400);
  assert.equal(calls, 0);
});

test('missing credentials return actionable setup information without contacting OpenAI', async t => {
  let calls = 0; const { post } = await app(t, () => { calls++; }, { apiKey: '' });
  const response = await post('/api/convert', payload); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'key_missing'); assert.equal(calls, 0);
});

test('conversion uses image edits with the supplied canvas, notes and chosen model', async t => {
  let received;
  const { post } = await app(t, async (url, options) => {
    received = { url, ...JSON.parse(options.body), authorization: options.headers.Authorization };
    return Response.json({ data: [{ b64_json: 'generated-image' }] });
  });
  const response = await post('/api/convert', payload); assert.equal(response.status, 200);
  assert.equal(received.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(received.model, 'gpt-image-2'); assert.equal(received.images[0].image_url, image);
  assert.match(received.prompt, /Golden runners/); assert.match(received.prompt, /A red sleigh please/);
  assert.equal(received.moderation, 'auto'); assert.equal(received.n, 1);
  assert.equal(received.input_fidelity, undefined);
  assert.equal((await response.json()).image, 'data:image/png;base64,generated-image');
});

test('live setup uses GPT-Live WebRTC and returns only connection information', async t => {
  let received;
  const { post } = await app(t, async (url, options) => {
    received = { url, ...JSON.parse(options.body) };
    return Response.json({ session: { id: 'live_test', secret: 'never-return' }, transport: { sdp: 'answer' }, extra: 'private' });
  });
  const response = await post('/api/session', { adultTest: true, sdp: 'v=0\r\n' });
  assert.equal(response.status, 201); assert.equal(received.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(received.session.model, 'gpt-live-1'); assert.equal(received.session.store, false);
  assert.equal(received.transport.type, 'webrtc'); assert.equal(received.session.audio.format, undefined);
  assert.match(received.session.instructions, /You cannot directly see the canvas/);
  assert.match(received.session.instructions, /There is no generate button/);
  assert.equal(received.session.delegation.type, 'client');
  assert.deepEqual(await response.json(), { session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer' } });
});

test('provider errors are sanitised, including moderation, model access and credit failures', async t => {
  for (const [upstream, code, expected, appCode] of [[401, 'invalid_api_key', 503, 'key_invalid'], [404, 'model_not_found', 503, 'model_access'], [429, 'insufficient_quota', 429, 'usage_limit'], [400, 'moderation_blocked', 422, 'moderation_blocked']]) {
    const { post } = await app(t, async () => Response.json({ error: { code, message: config.apiKey } }, { status: upstream }));
    const response = await post('/api/convert', payload); assert.equal(response.status, expected);
    const body = await response.json(); assert.equal(body.code, appCode); assert.ok(!JSON.stringify(body).includes(config.apiKey));
  }
});

test('a second conversion is refused while the first is in progress', async t => {
  let complete, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { post } = await app(t, async () => { entered(); return new Promise(resolve => { complete = () => resolve(Response.json({ data: [{ b64_json: 'result' }] })); }); });
  const first = post('/api/convert', payload); await started;
  assert.equal((await post('/api/convert', payload)).status, 429);
  complete(); assert.equal((await first).status, 200);
});

test('network failures and malformed provider results do not report success', async t => {
  for (const responder of [async () => { throw Error('network'); }, async () => Response.json({ data: [] })]) {
    const { post } = await app(t, responder); const response = await post('/api/convert', payload);
    assert.equal(response.status, 502); assert.match((await response.json()).error, /drawing is safe/i);
  }
});
