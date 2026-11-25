import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';
import { canvasLayout } from '../lib/canvas-layout.mjs';
import { validateDrawingPlan } from '../lib/drawing-agent.mjs';

const config = { apiKey: 'sk-test-not-a-real-key', liveModel: 'gpt-live-1.1', imageModel: 'gpt-image-2' };
// Boundary fixture: a PNG header with the canvas dimensions. Browser tests use decoded images.
const bytes = Buffer.alloc(25); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
bytes.write('IHDR', 12); bytes.writeUInt32BE(1536, 16); bytes.writeUInt32BE(1024, 20);
const image = `data:image/png;base64,${bytes.toString('base64')}`;
const payload = { adultTest: true, image, notes: 'Golden runners', conversation: 'You: A red sleigh please.' };
const drawPayload = { adultTest: true, image, conversation: 'You: Draw a little man.', viewport: { width: 1440, height: 1000 }, pointer: { x: 500, y: 400 } };
const drawingPlan = { action: 'draw', message: 'A little man', strokes: [{ colour: '#353c3b', width: 4, points: [{ x: 500, y: 300 }, { x: 500, y: 450 }] }] };
const helperResponse = plan => Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'draw_on_canvas', arguments: JSON.stringify(plan) }] });

test('Codex demo routes drawing and images to Codex while voice retains the OpenAI API', async t => {
  const calls = [];
  let closed = false;
  const codex = {
    status: async () => ({ connected: true }),
    draw: async () => { calls.push('codex-draw'); return drawingPlan; },
    convert: async () => { calls.push('codex-image'); return { image }; },
    close: () => { closed = true; },
  };
  const server = createApp({ getConfig: () => ({ ...config, backend: 'codex' }), codexFactory: () => codex,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
      return Response.json({ session: { id: 'voice' }, transport: { sdp: 'answer' } });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const local = await fetch(origin + '/api/config').then(response => response.json());
  assert.equal(local.backend, 'codex'); assert.equal(local.voiceConfigured, true);
  const post = (path, body, token = local.csrfToken) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sketchbook-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post('/api/draw', drawPayload, 'bad')).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await post('/api/draw', drawPayload)).status, 200);
  assert.equal((await post('/api/convert', payload)).status, 200);
  assert.equal((await post('/api/session', { adultTest: true, sdp: 'v=0\r\n' })).status, 201);
  assert.deepEqual(calls, ['codex-draw', 'codex-image', 'https://api.openai.com/v1/live/sessions']);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(closed, true);
});
const snapshotBytes = Buffer.from(bytes);
snapshotBytes.writeUInt32BE(1024, 16); snapshotBytes.writeUInt32BE(640, 20);
const snapshotImage = `data:image/png;base64,${snapshotBytes.toString('base64')}`;
const canvasContext = { adultTest: true, image: snapshotImage, viewport: { width: 1600, height: 1000 }, revision: 7,
  exclusions: [{ x: 400, y: 800, width: 200, height: 150 }], conversation: 'You: A green dragon.', scene: null };
const scene = { observation: 'Green marks on the left.', uncertainty: 'They may be a dragon.', plan: ['Leave room for its wings.'], suggestion: '' };
const visualResponse = (name, result) => Response.json({ status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(result) }] });

test('canvas assessment is read-only, revisioned and includes actual canvas geometry', async t => {
  let received;
  const { post } = await app(t, async (url, options) => {
    received = JSON.parse(options.body);
    return visualResponse('describe_canvas', scene);
  });
  const response = await post('/api/assess', canvasContext);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...scene, revision: 7 });
  const context = JSON.parse(received.input.find(item => item.role === 'user').content[0].text);
  assert.deepEqual(context.viewport, canvasContext.viewport);
  assert.deepEqual(context.exclusions, canvasContext.exclusions);
  assert.equal(received.input.find(item => item.role === 'user').content[1].image_url, snapshotImage);
  assert.equal(received.store, false);
  assert.equal(received.tool_choice.name, 'describe_canvas');
  assert.equal((await post('/api/assess', canvasContext)).status, 429);
});

test('visual context rejects mismatched geometry and invalid scene data before paid calls', async t => {
  let calls = 0;
  const { post } = await app(t, async () => { calls++; });
  for (const changes of [
    { viewport: { width: 1000, height: 1600 } }, { revision: -1 },
    { exclusions: [{ x: 990, y: 0, width: 20, height: 30 }] },
    { scene: { ...scene, plan: ['a', 'b', 'c', 'd'] } },
  ]) assert.equal((await post('/api/assess', { ...canvasContext, ...changes })).status, 400);
  assert.equal((await post('/api/review', { ...canvasContext, candidate: image })).status, 400);
  assert.equal((await post('/api/assess', canvasContext, { 'X-Sketchbook-Token': 'bad' })).status, 403);
  assert.equal(calls, 0);
});

test('offscreen review compares both snapshots and returns a bounded verdict without drawing', async t => {
  let received;
  const { post } = await app(t, async (url, options) => {
    received = JSON.parse(options.body);
    return visualResponse('review_drawing', { approved: false, message: 'The star covers the dragon.' });
  });
  const response = await post('/api/review', { ...canvasContext, candidate: snapshotImage });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { approved: false, message: 'The star covers the dragon.', revision: 7 });
  assert.equal(received.input.find(item => item.role === 'user').content.filter(item => item.type === 'input_image').length, 2);
  assert.equal(received.tool_choice.name, 'review_drawing');
});

test('malformed visual reports and unexpected tool calls cannot become scene context', async t => {
  for (const responder of [
    () => visualResponse('describe_canvas', { ...scene, observation: 'x'.repeat(601) }),
    () => visualResponse('draw_on_canvas', scene),
    () => Response.json({ status: 'incomplete', output: [] }),
  ]) {
    const { post } = await app(t, responder);
    assert.equal((await post('/api/assess', canvasContext)).status, 502);
  }
});

test('pen planning receives an unletterboxed snapshot, scene and normalized control regions', async t => {
  let received;
  const { post } = await app(t, async (url, options) => {
    received = JSON.parse(options.body);
    return helperResponse(drawingPlan);
  });
  const response = await post('/api/draw', { ...canvasContext, snapshot: true, pointer: { x: 700, y: 300 }, scene });
  assert.equal(response.status, 200);
  const context = JSON.parse(received.input.find(item => item.role === 'user').content[0].text);
  assert.deepEqual(context.scene, scene);
  assert.deepEqual(context.lastPointer, { x: 700, y: 300 });
  assert.deepEqual(context.exclusions, canvasContext.exclusions);
});

test('delegated helper receives the canvas and conversation and returns only validated strokes', async t => {
  let received;
  const { post } = await app(t, async (url, options) => { received = { url, ...JSON.parse(options.body) }; return helperResponse(drawingPlan); });
  const response = await post('/api/draw', drawPayload);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), drawingPlan);
  assert.equal(received.url, 'https://api.openai.com/v1/responses'); assert.equal(received.model, 'gpt-6.1-terra');
  assert.equal(received.reasoning.effort, 'medium');
  assert.equal(received.prompt_cache_options.mode, 'explicit');
  assert.equal(received.input[0].role, 'developer');
  assert.equal(received.store, false); assert.equal(received.tools[0].strict, true);
  assert.equal(received.input.find(item => item.role === 'user').content[1].image_url, image);
  assert.match(received.input.find(item => item.role === 'user').content[0].text, /Draw a little man/);
  assert.deepEqual(received.tool_choice, { type: 'function', name: 'draw_on_canvas' });
});

test('measured layout reserves hollow objects and controls and accounts for page aspect ratio', () => {
  const inkMap = Array(20).fill('.'.repeat(20));
  for (let row = 5; row <= 9; row++) inkMap[row] = '....' + (row === 5 || row === 9 ? '#####' : '#...#') + '.'.repeat(11);
  const layout = canvasLayout({ width: 400, height: 800 }, inkMap, [{ x: 0, y: 850, width: 1000, height: 150 }]);
  assert.deepEqual(layout.occupiedRegions, [{ x: 200, y: 250, width: 250, height: 250 }]);
  assert.equal(layout.coordinates.circleExample.radiusX, 100);
  assert.equal(layout.coordinates.circleExample.radiusY, 50);
  assert.ok(layout.freeRegions.length > 0);
  for (const rect of layout.freeRegions) {
    assert.ok(rect.y + rect.height <= 800, 'Leave breathing room above bottom controls.');
    assert.ok(rect.x + rect.width <= 150 || rect.x >= 500 || rect.y + rect.height <= 200 || rect.y >= 550,
      'Do not suggest drawing inside an existing hollow object.');
  }
});

test('drawing tool accepts its full advertised point budget', () => {
  const points = Array.from({ length: 64 }, (_, index) => ({ x: index * 10, y: index * 10 }));
  const plan = { ...drawingPlan, strokes: Array.from({ length: 32 }, () => ({ colour: '#353c3b', width: 3, points })) };
  assert.equal(validateDrawingPlan(plan).strokes.length, 32);
});

test('filled polygons retain their palette colour and reject invalid or degenerate fills', () => {
  const stroke = { colour: '#353c3b', fill: '#be4147', width: 4,
    points: [{ x: 200, y: 200 }, { x: 400, y: 200 }, { x: 300, y: 400 }] };
  assert.equal(validateDrawingPlan({ ...drawingPlan, strokes: [stroke] }).strokes[0].fill, '#be4147');
  assert.throws(() => validateDrawingPlan({ ...drawingPlan, strokes: [{ ...stroke, fill: 'red' }] }));
  assert.throws(() => validateDrawingPlan({ ...drawingPlan, strokes: [{ ...stroke, points: [stroke.points[0], stroke.points[0], stroke.points[1]] }] }));
  assert.equal(validateDrawingPlan({ ...drawingPlan, strokes: [{ ...stroke, fill: null }] }).strokes[0].fill, undefined);
});

test('targeted removal accepts only white strokes and undo cannot contain drawing commands', () => {
  const stroke = { colour: '#ffffff', fill: '#ffffff', width: 2,
    points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }] };
  assert.equal(validateDrawingPlan({ action: 'erase', message: 'Remove the star.', strokes: [stroke] }).action, 'erase');
  assert.throws(() => validateDrawingPlan({ action: 'erase', message: '', strokes: [{ ...stroke, colour: '#be4147' }] }));
  assert.throws(() => validateDrawingPlan({ action: 'undo', message: '', strokes: [stroke] }));
});

test('planner receives measured layout and bounded repair feedback; invalid maps never reach the API', async t => {
  let received, calls = 0;
  const { post } = await app(t, async (url, options) => {
    calls++; received = JSON.parse(options.body); return helperResponse(drawingPlan);
  });
  const inkMap = Array(20).fill('.'.repeat(20)); inkMap[5] = '.....###............';
  const repair = { previousPlan: drawingPlan, feedback: 'The runners overlap the body; separate them vertically.' };
  assert.equal((await post('/api/draw', { ...canvasContext, snapshot: true, pointer: null, inkMap, repair })).status, 200);
  const context = JSON.parse(received.input.find(item => item.role === 'user').content[0].text);
  assert.equal(context.layout.measured, true);
  assert.deepEqual(context.layout.occupiedRegions, [{ x: 250, y: 250, width: 150, height: 50 }]);
  assert.deepEqual(context.repair, repair);
  for (const changes of [{ inkMap: ['bad'] }, { repair: { ...repair, feedback: 'x'.repeat(501) } },
    { repair: { ...repair, previousPlan: { ...drawingPlan, action: 'convert' } } }]) {
    assert.equal((await post('/api/draw', { ...drawPayload, ...changes })).status, 400);
  }
  assert.equal(calls, 1);
});

test('truncated drawing output has a specific diagnosis and is not executed', async t => {
  const { post } = await app(t, async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
  const response = await post('/api/draw', drawPayload);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'drawing_incomplete');
});

test('helper can request a photo or decline an unclear request without returning strokes', async t => {
  for (const action of ['convert', 'none', 'cancel', 'undo']) {
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

test('canvas limits prevent invalid submissions', async t => {
  let calls = 0; const { post } = await app(t, () => { calls++; });
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
  assert.equal(received.session.model, 'gpt-live-1.1'); assert.equal(received.session.store, false);
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

test('credit exhaustion, spending limits and temporary rate limits retain distinct diagnostic codes with child-facing messages', async t => {
  for (const [code, type, expectedCode, message] of [
    ['credit_balance_exhausted', 'insufficient_quota', 'credit_balance_exhausted', /needs a break/],
    ['project_spend_limit_exceeded', 'insufficient_quota', 'spend_limit', /needs a break/],
    ['organization_spend_limit_exceeded', 'insufficient_quota', 'spend_limit', /needs a break/],
    ['organization_usage_limit_exceeded', 'insufficient_quota', 'usage_limit', /needs a break/],
    ['rate_limit_exceeded', 'rate_limit_error', 'rate_limit', /wait a little/],
    ['slow_down', 'rate_limit_error', 'rate_limit', /wait a little/],
    [null, 'insufficient_quota', 'usage_limit', /needs a break/],
    [null, null, 'usage_limit', /needs a break/],
  ]) {
    const { post } = await app(t, async () => Response.json({ error: { code, type, message: config.apiKey } }, { status: 429 }));
    const response = await post('/api/convert', payload);
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.code, expectedCode);
    assert.match(body.error, message);
    assert.ok(!JSON.stringify(body).includes(config.apiKey));
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
