import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodex } from '../lib/codex.mjs';
import { CodexRpc } from '../lib/codex-rpc.mjs';

const plan = { action: 'draw', message: 'One star.', strokes: [{ colour: '#e8ac47', width: 4, points: [{ x: 100, y: 100 }, { x: 200, y: 200 }] }] };
const image = 'data:image/png;base64,iVBORw0KGgo=';

class FakeRpc extends EventEmitter {
  constructor(output = plan) { super(); this.output = output; this.requests = []; }
  async start() {}
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: 'test-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('item/completed', { threadId: 'test-thread', item: this.imageItem || { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(this.output) } });
        this.emit('turn/completed', { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed' } });
      });
      return { turn: { id: 'test-turn' } };
    }
    return {};
  }
  close() { this.closed = true; }
}

test('Codex drawing uses a constrained ephemeral turn and validates returned strokes', async () => {
  const rpc = new FakeRpc();
  const provider = createCodex({ drawingModel: 'gpt-6-luna', apiKey: 'never-send-this-key' }, { rpc });
  const result = await provider.draw({ image, conversation: 'Draw a star.', viewport: { width: 1000, height: 800 }, pointer: null });
  assert.deepEqual(result, plan);
  const thread = rpc.requests.find(item => item.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.approvalPolicy, 'never');
  const turn = rpc.requests.find(item => item.method === 'turn/start').params;
  assert.equal(turn.input[1].url, image);
  assert.equal(turn.outputSchema.additionalProperties, false);
  assert.ok(!JSON.stringify(rpc.requests).includes('never-send-this-key'));
  assert.equal(rpc.listenerCount('item/completed'), 0);
  provider.close(); assert.equal(rpc.closed, true);
});

test('Codex rejects out-of-bounds model output', async () => {
  const invalid = { ...plan, strokes: [{ ...plan.strokes[0], points: [{ x: -1, y: 2 }, { x: 3, y: 4 }] }] };
  const provider = createCodex({}, { rpc: new FakeRpc(invalid) });
  await assert.rejects(() => provider.draw({ image, conversation: 'Draw.' }), /outside the page/);
});

test('Codex assessment and review retain the caller canvas revision', async () => {
  const scene = { observation: 'One star.', uncertainty: '', plan: [], suggestion: '' };
  const provider = createCodex({}, { rpc: new FakeRpc(scene) });
  assert.deepEqual(await provider.assess({ image, revision: 12 }), { ...scene, revision: 12 });
  const review = createCodex({}, { rpc: new FakeRpc({ approved: false, message: 'Overlaps.' }) });
  assert.deepEqual(await review.review({ image, candidate: image, revision: 13 }), { approved: false, message: 'Overlaps.', revision: 13 });
});

test('Codex refuses image output outside its request directory', async () => {
  const rpc = new FakeRpc();
  rpc.imageItem = { type: 'imageGeneration', status: 'completed', savedPath: resolve('README.md') };
  const provider = createCodex({}, { rpc });
  await assert.rejects(() => provider.convert(image, '', ''), error => error.code === 'codex_image_path');
});

test('Codex reads an image from the native cache for this exact thread', async () => {
  const previousHome = process.env.CODEX_HOME;
  const directory = await mkdtemp(resolve('artifacts/codex-cache-test-'));
  process.env.CODEX_HOME = directory;
  try {
    const cache = join(directory, 'generated_images', 'test-thread');
    await mkdir(cache, { recursive: true });
    const savedPath = join(cache, 'result.png');
    const png = Buffer.from([137,80,78,71,13,10,26,10]);
    await writeFile(savedPath, png);
    const rpc = new FakeRpc();
    rpc.imageItem = { type: 'imageGeneration', status: 'completed', savedPath };
    const result = await createCodex({}, { rpc }).convert(image, '', '');
    assert.equal(result.image, `data:image/png;base64,${png.toString('base64')}`);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex does not report a text-only completion as image generation', async () => {
  const provider = createCodex({}, { rpc: new FakeRpc({ available: true }) });
  await assert.rejects(() => provider.convert(image, '', ''), error => error.code === 'codex_image_missing');
});

test('RPC errors are sanitised and unknown client tools are denied', async () => {
  const rpc = new CodexRpc();
  const sent = [];
  rpc.child = { stdin: { writable: true, write: data => sent.push(JSON.parse(data)) } };
  const request = rpc.request('test', {});
  rpc.receive(JSON.stringify({ id: 1, error: { message: 'secret-should-not-leak' } }));
  await assert.rejects(request, error => error.code === 'codex_error' && !error.message.includes('secret-should-not-leak'));
  rpc.receive(JSON.stringify({ id: 9, method: 'item/tool/call', params: { tool: 'execute_shell' } }));
  assert.equal(sent.at(-1).error.code, -32601);
  assert.doesNotThrow(() => rpc.receive(JSON.stringify({ method: 'error', params: {} })));
});
