import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function openTools(page) {
  await expect(page.locator('#controls-panel')).toBeVisible();
}
async function mockVoice(page) {
  await page.addInitScript(() => {
    window.liveTest = { sent: [] };
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [] });
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = 'complete';
      addTrack() {} close() {}
      createDataChannel() {
        const channel = new EventTarget(); channel.readyState = 'open'; channel.close = () => {};
        channel.send = message => liveTest.sent.push(JSON.parse(message));
        liveTest.channel = this.channel = channel; return channel;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() { this.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.started' }) })); }
    };
  });
  await page.route('**/api/session', route => route.fulfill({ json: { session: { id: 'test' }, transport: { sdp: 'answer' } } }));
}
async function delegate(page, text, id = 'delegate-1') {
  await page.evaluate(({ text, id }) => {
    const emit = data => liveTest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    if (text) emit({ type: 'session.input_transcript.delta', delta: text, start_ms: Date.now(), end_ms: Date.now() + 100 });
    emit({ type: 'session.delegation.created', delegation: { id, target: 'client', type: 'delegation' } });
  }, { text, id });
}
async function mockConversionPlan(page) {
  await page.route('**/api/draw', route => route.fulfill({ json: { action: 'convert', message: 'Turn this into a photo.', strokes: [] } }));
}
async function configured(page, backend = 'openai') {
  await page.route('**/api/assess', route => route.fulfill({ json: {
    observation: 'A drawing on the page.', uncertainty: '', plan: [], suggestion: '',
    revision: route.request().postDataJSON().revision,
  } }));
  await page.route('**/api/review', route => route.fulfill({ json: {
    approved: true, message: 'The requested drawing is recognisable and appropriately placed.',
    revision: route.request().postDataJSON().revision,
  } }));
  await page.route('**/api/config', route => route.fulfill({ json: { configured: true, backend, voiceConfigured: true, csrfToken: 'test-token', liveModel: 'gpt-live-1.1', imageModel: 'gpt-image-2' } }));
  await page.goto('/');
  await openTools(page);
}
async function canvasData(page) { return page.locator('#drawing').evaluate(canvas => canvas.toDataURL()); }

test('voice stays active beyond three minutes and can still be stopped', async ({ page }) => {
  await mockVoice(page); await configured(page);
  await page.clock.install();
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await page.clock.fastForward(240_000);
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  expect(await page.evaluate(() => liveTest.sent.some(event => event.type === 'session.close'))).toBe(false);
  await expect(page.locator('#notice')).not.toContainText('Time for a little break');
  await page.locator('#voice').click();
  expect(await page.evaluate(() => liveTest.sent.some(event => event.type === 'session.close'))).toBe(true);
});

const littleMan = { action: 'draw', message: 'A little man.', strokes: [
  { colour: '#353c3b', width: 5, points: [{x:475,y:300},{x:475,y:270},{x:500,y:250},{x:525,y:270},{x:525,y:300},{x:500,y:320},{x:475,y:300}] },
  { colour: '#353c3b', width: 5, points: [{x:500,y:320},{x:500,y:440},{x:460,y:500}] },
  { colour: '#353c3b', width: 5, points: [{x:500,y:440},{x:540,y:500}] },
  { colour: '#353c3b', width: 5, points: [{x:440,y:350},{x:500,y:370},{x:560,y:350}] },
] };

test('Codex demo accepts a typed drawing request without opening an API voice session', async ({ page }) => {
  await configured(page, 'codex');
  let voiceCalls = 0, submitted;
  page.on('request', request => { if (request.url().endsWith('/api/session')) voiceCalls++; });
  await page.route('**/api/draw', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: littleMan }); });
  const initial = await canvasData(page);
  await page.locator('#ideas-button').click();
  await page.locator('#demo-request').fill('Draw a little man.');
  await page.locator('#demo-submit').click();
  await expect(page.locator('#drawing-cursor')).toBeVisible();
  await expect(page.locator('#stop-action')).toBeHidden({ timeout: 15000 });
  expect(submitted.conversation).toContain('Draw a little man.');
  expect(await canvasData(page)).not.toBe(initial);
  expect(voiceCalls).toBe(0);
});

test('Codex demo accepts typed enhancement and reveals the image through snowfall', async ({ page }) => {
  await configured(page, 'codex');
  await page.locator('#starter').click();
  const image = await canvasData(page);
  await page.route('**/api/draw', route => route.fulfill({ json: { action: 'convert', message: 'Enhance the picture.', strokes: [] } }));
  await page.route('**/api/convert', route => route.fulfill({ json: { image } }));
  await page.locator('#ideas-button').click();
  await page.locator('#demo-request').fill('Turn this into a cool image.');
  await page.locator('#demo-submit').click();
  await expect(page.locator('#snow-overlay')).toBeVisible();
  await expect(page.locator('#snow-overlay')).toBeHidden({ timeout: 7000 });
  await expect(page.locator('#notice')).toContainText('Look what you imagined');
});

test('voice delegates a visible pen drawing once and Undo restores the entire previous page', async ({ page }) => {
  await mockVoice(page); await configured(page); await page.locator('#starter').click(); const initial = await canvasData(page);
  let calls = 0, submitted;
  await page.route('**/api/draw', route => { calls++; submitted = route.request().postDataJSON(); return route.fulfill({ json: littleMan }); });
  await page.locator('#voice').click(); await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man please.'); await delegate(page, null);
  await expect(page.locator('#drawing-cursor')).toBeVisible();
  const firstPosition = await page.locator('#drawing-cursor').boundingBox();
  await expect.poll(async () => (await page.locator('#drawing-cursor').boundingBox())?.x).not.toBe(firstPosition.x);
  await expect(page.locator('#stop-action')).toBeHidden({ timeout: 15000 });
  expect(calls).toBe(1); expect(submitted.conversation).toContain('Draw a little man');
  expect(submitted.image).toMatch(/^data:image\/png;base64,/);
  expect(await canvasData(page)).not.toBe(initial);
  expect(await page.evaluate(() => liveTest.sent.some(event => event.delegation_id === 'delegate-1' && event.content.includes('completed successfully')))).toBe(true);
  await page.locator('#undo').click(); expect(await canvasData(page)).toBe(initial);
  await delegate(page, null, 'duplicate-with-new-id');
  await expect(page.locator('#stop-action')).toBeHidden(); expect(calls).toBe(1);
});

test('stopping a moving drawing cursor rolls back all its strokes', async ({ page }) => {
  await mockVoice(page); await configured(page); const initial = await canvasData(page);
  await page.route('**/api/draw', route => route.fulfill({ json: littleMan }));
  await page.locator('#voice').click(); await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.'); await expect(page.locator('#drawing-cursor')).toBeVisible();
  await expect.poll(() => canvasData(page)).not.toBe(initial);
  await page.locator('#stop-action').click(); await expect(page.locator('#stop-action')).toBeHidden();
  await expect(page.locator('#drawing-cursor')).toBeHidden(); expect(await canvasData(page)).toBe(initial);
  await expect(page.locator('#undo')).toBeDisabled();
});

test('delegated progress persists during a slow plan, follows real stages and clears on completion', async ({ page }) => {
  await mockVoice(page); await configured(page);
  let planning, reviewing;
  await page.route('**/api/draw', route => { planning = route; });
  await page.route('**/api/review', route => { reviewing = route; });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect.poll(() => Boolean(planning)).toBe(true);
  await page.waitForTimeout(4800);
  await expect(page.locator('#work-status')).toBeVisible();
  await expect(page.locator('#work-status')).toHaveText('Our friend is planning your picture…');
  await expect(page.locator('#work-status')).toHaveClass(/working/);
  await page.screenshot({ path: 'artifacts/delegated-progress.png' });
  await planning.fulfill({ json: littleMan });
  await expect.poll(() => Boolean(reviewing)).toBe(true);
  await expect(page.locator('#work-status')).toHaveText('Our friend is checking the shapes…');
  await reviewing.fulfill({ json: { approved: true, message: 'Fits.', revision: reviewing.request().postDataJSON().revision } });
  await expect(page.locator('#work-status')).toHaveText('Our friend is drawing your picture…');
  await expect(page.locator('#stop-action')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#work-status')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('There you go!');
});

test('a rejected offscreen drawing leaves the real canvas and Undo history unchanged', async ({ page }) => {
  await mockVoice(page); await configured(page);
  const initial = await canvasData(page);
  let reviews = 0;
  await page.route('**/api/draw', route => route.fulfill({ json: littleMan }));
  await page.route('**/api/review', route => {
    reviews++;
    return route.fulfill({ json: { approved: false, message: 'The candidate overlaps the existing drawing.', revision: route.request().postDataJSON().revision } });
  });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect.poll(() => reviews).toBeGreaterThan(0);
  await expect(page.locator('#stop-action')).toBeHidden({ timeout: 15000 });
  expect(await canvasData(page)).toBe(initial);
  await expect(page.locator('#drawing-cursor')).toBeHidden();
  await expect(page.locator('#undo')).toBeDisabled();
});

test('mobile drawing snapshots match the page aspect ratio and include control exclusions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVoice(page); await configured(page);
  let submitted;
  await page.route('**/api/draw', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: littleMan });
  });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect.poll(() => Boolean(submitted)).toBe(true);
  const png = Buffer.from(submitted.image.split(',')[1], 'base64');
  expect(png.readUInt32BE(16) / png.readUInt32BE(20)).toBeCloseTo(390 / 844, 2);
  expect(submitted.viewport).toEqual({ width: 390, height: 844 });
  expect(submitted.exclusions.length).toBeGreaterThan(0);
  expect(submitted.inkMap).toHaveLength(20);
  expect(submitted.inkMap.every(row => /^[.#]{20}$/.test(row))).toBe(true);
  await page.locator('#stop-action').click();
  await expect(page.locator('#stop-action')).toBeHidden();
});

test('visual rejection revises once against the unchanged canvas and draws only the approved result', async ({ page }) => {
  await mockVoice(page); await configured(page);
  const initial = await canvasData(page);
  const requests = [];
  let reviews = 0;
  await page.route('**/api/draw', async route => {
    requests.push(route.request().postDataJSON());
    expect(await canvasData(page)).toBe(initial);
    await route.fulfill({ json: littleMan });
  });
  await page.route('**/api/review', route => {
    reviews++;
    return route.fulfill({ json: { approved: reviews === 2, message: reviews === 1 ? 'Separate the head from the hat.' : 'Fits well.',
      revision: route.request().postDataJSON().revision } });
  });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect(page.locator('#notice')).toHaveText('There you go! You can add to it or Undo.', { timeout: 15000 });
  expect(requests).toHaveLength(2);
  expect(requests[1].image).toBe(requests[0].image);
  expect(requests[1].repair).toEqual({ previousPlan: littleMan, feedback: 'Separate the head from the hat.' });
  expect(reviews).toBe(2);
  await page.locator('#undo').click();
  expect(await canvasData(page)).toBe(initial);
});

test('measured ink map locates marks and rejected repairs stop after two plans', async ({ page }) => {
  await mockVoice(page); await configured(page);
  await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(180, 160); await page.mouse.up();
  const initial = await canvasData(page);
  let plans = 0;
  await page.route('**/api/draw', route => {
    plans++;
    const body = route.request().postDataJSON();
    expect(body.inkMap.some(row => row.includes('#'))).toBe(true);
    expect(body.inkMap[19]).toBe('.'.repeat(20));
    return route.fulfill({ json: littleMan });
  });
  await page.route('**/api/review', route => route.fulfill({ json: { approved: false, message: 'The shapes overlap.',
    revision: route.request().postDataJSON().revision } }));
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect(page.locator('#notice')).toContainText('after revising it', { timeout: 15000 });
  expect(plans).toBe(2);
  expect(await canvasData(page)).toBe(initial);
});

test('bucket fills one enclosed area, keeps the chosen tool when changing colour, and supports Undo', async ({ page }) => {
  await configured(page);
  await page.getByRole('button', { name: 'Charcoal', exact: true }).click();
  await page.mouse.move(120, 110); await page.mouse.down();
  for (const [x, y] of [[300, 110], [300, 280], [120, 280], [120, 110]]) await page.mouse.move(x, y);
  await page.mouse.up();
  const before = await canvasData(page);
  await page.getByRole('button', { name: 'Fill colour', exact: true }).click();
  await page.getByRole('button', { name: 'Winter blue', exact: true }).click();
  await expect(page.locator('#fill')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(200, 190);
  const pixels = await page.locator('#drawing').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect(), ctx = canvas.getContext('2d');
    const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * canvas.width / bounds.width), Math.floor(y * canvas.height / bounds.height), 1, 1).data];
    return { inside: pixel(200, 190), outside: pixel(350, 190), outline: pixel(120, 190) };
  });
  expect(pixels.inside).toEqual([107, 152, 198, 255]);
  expect(pixels.outside).toEqual([255, 255, 255, 255]);
  expect(pixels.outline).toEqual([53, 60, 59, 255]);
  await page.locator('#undo').click();
  expect(await canvasData(page)).toBe(before);
});

test('agent filled shapes render identically to previews, Undo as one action, and cannot enclose controls', async ({ page }) => {
  await configured(page);
  const result = await page.evaluate(async () => {
    const { Drawing, DrawingCursor } = await import('/drawing.js');
    const canvas = document.getElementById('drawing');
    const board = new Drawing(canvas, () => {});
    const initial = canvas.toDataURL();
    const stroke = { colour: '#353c3b', fill: '#be4147', width: 4,
      points: [{ x: 100, y: 100 }, { x: 350, y: 100 }, { x: 300, y: 350 }, { x: 100, y: 350 }] };
    let blocked = false;
    try { board.preview([stroke], [{ x: 150, y: 150, width: 50, height: 50 }]); }
    catch { blocked = true; }
    const preview = board.preview([stroke], []);
    const cursor = new DrawingCursor(board, document.getElementById('drawing-cursor'));
    await cursor.draw([stroke], new AbortController().signal);
    const actual = board.visionSnapshot().image;
    const pixel = [...board.ctx.getImageData(Math.round(canvas.width * .2), Math.round(canvas.height * .2), 1, 1).data];
    board.undo();
    return { identical: actual === preview, blocked, pixel, restored: canvas.toDataURL() === initial };
  });
  expect(result).toEqual({ identical: true, blocked: true, pixel: [190, 65, 71, 255], restored: true });
});

test('cancelled planning cannot paint a late result and ordinary chat does not call the helper', async ({ page }) => {
  await mockVoice(page); await configured(page); const initial = await canvasData(page);
  let calls = 0, pending;
  await page.route('**/api/draw', route => { calls++; pending = route; });
  await page.locator('#voice').click(); await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await page.evaluate(() => liveTest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'I like red.', start_ms: 0, end_ms: 100 }) })));
  expect(calls).toBe(0);
  await delegate(page, 'Draw a little man.'); await expect.poll(() => calls).toBe(1);
  await page.keyboard.press('Escape'); await expect(page.locator('#stop-action')).toBeHidden();
  await pending.fulfill({ json: littleMan });
  await expect(page.locator('#pen')).toBeEnabled(); expect(await canvasData(page)).toBe(initial);
  await expect(page.locator('#drawing-cursor')).toBeHidden();
});

test('the child can keep drawing during planning and a stale plan cannot overwrite those marks', async ({ page }) => {
  await mockVoice(page); await configured(page);
  let pending, reviews = 0;
  await page.route('**/api/draw', route => { pending = route; });
  await page.route('**/api/review', route => { reviews++; return route.fulfill({ json: { approved: true, message: '', revision: route.request().postDataJSON().revision } }); });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Draw a little man.');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.locator('#pen')).toBeEnabled();
  await page.mouse.move(90, 100); await page.mouse.down();
  await page.mouse.move(200, 160, { steps: 8 }); await page.mouse.up();
  const ownDrawing = await canvasData(page);
  await pending.fulfill({ json: littleMan });
  await expect(page.locator('#stop-action')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('drawing changed');
  expect(await canvasData(page)).toBe(ownDrawing);
  expect(reviews).toBe(0);
});

test('background observation leaves drawing enabled and drops results for an older canvas', async ({ page }) => {
  await mockVoice(page); await configured(page);
  await page.locator('#starter').click();
  let pending;
  await page.route('**/api/assess', route => { pending = route; });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.locator('#pen')).toBeEnabled();
  const before = await canvasData(page);
  await page.mouse.move(80, 100); await page.mouse.down();
  await page.mouse.move(190, 180, { steps: 8 }); await page.mouse.up();
  expect(await canvasData(page)).not.toBe(before);
  await pending.fulfill({ json: { observation: 'OLD_PICTURE_MUST_NOT_BE_USED', uncertainty: '', plan: [], suggestion: '', revision: pending.request().postDataJSON().revision } });
  await page.locator('#voice').click();
  expect(await page.evaluate(() => liveTest.sent.some(event => event.content?.includes('OLD_PICTURE_MUST_NOT_BE_USED')))).toBe(false);
});

test('Stop remains responsive while a delegated action waits for a background observation', async ({ page }) => {
  await mockVoice(page); await configured(page);
  await page.locator('#starter').click();
  let pending, drawingCalls = 0;
  await page.route('**/api/assess', route => { pending = route; });
  await page.route('**/api/draw', route => { drawingCalls++; return route.fulfill({ json: littleMan }); });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await delegate(page, 'Draw a little man.');
  await expect(page.locator('#stop-action')).toBeVisible();
  await page.waitForTimeout(500);
  expect(drawingCalls).toBe(0);
  await page.locator('#stop-action').click();
  await expect(page.locator('#stop-action')).toBeHidden({ timeout: 2500 });
  await pending.fulfill({ json: { observation: 'A sketch.', uncertainty: '', plan: [], suggestion: '', revision: pending.request().postDataJSON().revision } });
  expect(drawingCalls).toBe(0);
});

test('cancelled photo conversion preserves the source when its image arrives late', async ({ page }) => {
  await mockVoice(page); await mockConversionPlan(page); await configured(page);
  await page.locator('#starter').click(); const initial = await canvasData(page); let pending;
  await page.route('**/api/convert', route => { pending = route; });
  await page.locator('#voice').click(); await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Turn this into a photo.'); await expect.poll(() => Boolean(pending)).toBe(true);
  await page.locator('#stop-action').click(); await expect(page.locator('#stop-action')).toBeHidden();
  await pending.fulfill({ json: { image: initial } });
  await expect(page.locator('#snow-overlay')).toBeHidden(); expect(await canvasData(page)).toBe(initial);
});

test('ending voice while an image is generating lets the picture finish', async ({ page }) => {
  await mockVoice(page); await mockConversionPlan(page); await configured(page);
  await page.locator('#starter').click();
  const source = await canvasData(page);
  let pending;
  await page.route('**/api/convert', route => { pending = route; });
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Imagine this.');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(() => liveTest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.closed' }) })));
  await expect(page.locator('#stop-action')).toBeVisible();
  await pending.fulfill({ json: { image: source } });
  await expect(page.locator('#notice')).toHaveText('Look what you imagined!', { timeout: 12000 });
});

test('drawing, colour, thickness, eraser and undo operate on the actual canvas', async ({ page }) => {
  await page.goto('/'); const initial = await canvasData(page);
  await openTools(page);
  const canvas = page.locator('#drawing'), bounds = await canvas.boundingBox();
  await page.getByRole('button', { name: 'Winter blue', exact: true }).click();
  await page.getByRole('button', { name: 'Pen thickness', exact: true }).click();
  await page.locator('#thickness').fill('30');
  await page.mouse.move(bounds.x + 100, bounds.y + 100); await page.mouse.down();
  await page.mouse.move(bounds.x + 240, bounds.y + 170, { steps: 20 }); await page.mouse.up();
  const drawn = await canvasData(page); expect(drawn).not.toBe(initial);
  await expect(page.locator('#empty-hint')).toHaveCount(0);
  await expect(page.locator('#magic')).toHaveCount(0);
  await page.getByRole('button', { name: 'Eraser', exact: true }).click();
  await page.mouse.click(bounds.x + 170, bounds.y + 135);
  expect(await canvasData(page)).not.toBe(drawn);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await canvasData(page)).toBe(drawn);
  await page.keyboard.press('Control+z'); expect(await canvasData(page)).toBe(initial);
});

test('snowfall preview uses no paid endpoint and preserves the drawing', async ({ page }) => {
  let paidCalls = 0; page.on('request', req => { if (req.method() === 'POST') paidCalls++; });
  await page.goto('/'); await openTools(page); await page.locator('#starter').click(); const initial = await canvasData(page);
   await page.locator('#preview-snow').click();
  await expect(page.locator('#snow-overlay')).toBeVisible();
  expect(await page.locator('#snow-overlay').boundingBox()).toEqual(await page.locator('#drawing').boundingBox());
  const firstSnowFrame = await page.locator('#snow').evaluate(canvas => canvas.toDataURL());
  await expect.poll(() => page.locator('#snow').evaluate(canvas => canvas.toDataURL())).not.toBe(firstSnowFrame);
  await expect(page.locator('#snow-overlay')).toHaveClass(/at-lake/);
  await page.screenshot({ path: 'artifacts/icy-lake-preview.png' });
  await expect(page.locator('#snow-overlay')).toBeHidden({ timeout: 7000 });
  expect(await canvasData(page)).toBe(initial); expect(paidCalls).toBe(0);
});

test('child-facing flow delegates undo without setup or payment confirmation', async ({ page }) => {
  await mockVoice(page); await configured(page);
  await expect(page.locator('#setup-dialog')).toHaveCount(0);
  const blank = await canvasData(page);
  await page.locator('#starter').click();
  await page.route('**/api/draw', route => route.fulfill({ json: { action: 'undo', message: 'Back one step.', strokes: [] } }));
  await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Undo that last change.');
  await expect(page.locator('#notice')).toHaveText('Back one step!');
  expect(await canvasData(page)).toBe(blank);
});

test('reduced-motion snowfall still covers and reveals the unchanged drawing without moving particles', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#starter').click();
  const initial = await canvasData(page);

  await page.locator('#preview-snow').click();
  await expect(page.locator('#snow-overlay')).toBeVisible();
  await expect(page.locator('#snow-overlay')).toHaveClass(/at-lake/);
  const still = await page.locator('#snow').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(100);
  expect(await page.locator('#snow').evaluate(canvas => canvas.toDataURL())).toBe(still);
  await expect(page.locator('#snow-overlay')).toBeHidden({ timeout: 5000 });
  expect(await canvasData(page)).toBe(initial);
});

test('conversion submits source and notes, reveals the new image and can undo it', async ({ page }) => {
  await mockVoice(page); await mockConversionPlan(page);
  await configured(page); await page.locator('#starter').click(); const initial = await canvasData(page);
  const output = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 1024; const context = canvas.getContext('2d'); context.fillStyle = '#77aadd'; context.fillRect(0,0,1536,1024); return canvas.toDataURL(); });
  let submitted;
  await page.route('**/api/convert', async route => { submitted = route.request().postDataJSON(); await new Promise(resolve => setTimeout(resolve, 300)); await route.fulfill({ json: { image: output } }); });
  await page.locator('#ideas-button').click(); await page.locator('#notes').fill('Golden runners and red presents');
  await page.getByRole('button', { name: 'Close ideas' }).click(); await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Turn this into a photo please.');
  await expect(page.locator('#snow-overlay')).toBeVisible(); await expect(page.locator('#pen')).toBeDisabled();
  await expect(page.locator('#snow-overlay')).toBeHidden({ timeout: 7000 });
  expect(submitted.image).toMatch(/^data:image\/png;base64,/); expect(submitted.notes).toContain('Golden runners');
  expect(await canvasData(page)).not.toBe(initial);
  expect(await page.locator('#drawing').evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data))).toEqual([119,170,221,255]);
  await openTools(page);
  await page.locator('#undo').click(); expect(await canvasData(page)).toBe(initial);
});

test('failed generation clears snowfall and leaves all original pixels intact', async ({ page }) => {
  await mockVoice(page); await mockConversionPlan(page);
  await configured(page); await page.locator('#starter').click(); const initial = await canvasData(page);
  await page.route('**/api/convert', route => route.fulfill({ status: 429, json: { error: 'OpenAI has reached a usage or credit limit.' } }));
  await page.locator('#voice').click(); await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await delegate(page, 'Turn this into a photo.'); await expect(page.locator('#notice')).toContainText('credit limit');
  await expect(page.locator('#snow-overlay')).toBeHidden(); expect(await canvasData(page)).toBe(initial);
  await expect(page.locator('#pen')).toBeEnabled();
});

test('voice stop, mute, transcript and a late microphone permission response clean up correctly', async ({ page }) => {
  await page.addInitScript(() => {
    window.voiceTest = { stopped: 0, sent: [], tracks: [] };
    const fakeTrack = () => { const track = { enabled: true, stop() { window.voiceTest.stopped++; } }; window.voiceTest.tracks.push(track); return track; };
    navigator.mediaDevices.getUserMedia = async () => { const track = fakeTrack(); return { getTracks: () => [track], getAudioTracks: () => [track] }; };
    class Peer extends EventTarget {
      iceGatheringState = 'complete'; connectionState = 'connected';
      addTrack() {} close() {}
      createDataChannel() { const channel = new EventTarget(); channel.readyState = 'open'; channel.send = value => { const data = JSON.parse(value); window.voiceTest.sent.push(data); if (data.type === 'session.close') setTimeout(() => channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.closed' }) })), 20); }; channel.close = () => {}; this.channel = channel; window.voiceTest.channel = channel; return channel; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() { this.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.started' }) })); }
    }
    window.RTCPeerConnection = Peer;
  });
  await page.route('**/api/session', route => route.fulfill({ json: { session: { id: 'live_test' }, transport: { sdp: 'answer' } } }));
  await configured(page); await page.locator('#voice').click();
  await expect(page.locator('#voice-state')).toContainText('Microphone on');
  await openTools(page);
  await page.locator('#mute').click(); expect(await page.evaluate(() => voiceTest.tracks[0].enabled)).toBe(false);
  await page.evaluate(() => { for (const delta of ['A golden ', 'sleigh!']) voiceTest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.output_transcript.delta', delta, start_ms: 1, end_ms: 100 }) })); });
  await expect(page.locator('#caption')).toHaveText('A golden sleigh!');
  await page.locator('#voice').click(); await expect(page.locator('#voice-label')).toHaveText('Talk to Santa’s little helper');
  expect(await page.evaluate(() => voiceTest.stopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => voiceTest.sent.some(event => event.type === 'session.close'))).toBe(true);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveMicrophone = resolve; }); });
  await page.locator('#voice').click(); await expect(page.locator('#voice-label')).toHaveText('Cancel connection');
  await page.locator('#voice').click();
  await page.evaluate(() => resolveMicrophone({ getTracks: () => [{ stop() { voiceTest.lateStopped = true; } }] }));
  await expect.poll(() => page.evaluate(() => voiceTest.lateStopped)).toBe(true);
  await expect(page.locator('#voice-label')).toHaveText('Talk to Santa’s little helper');
});

test('upload, download and fresh page work without an API key', async ({ page }) => {
  await page.goto('/'); await openTools(page); await page.locator('#starter').click(); const initial = await canvasData(page);
  await page.locator('#file').setInputFiles({ name: 'sketch.png', mimeType: 'image/png', buffer: Buffer.from(initial.split(',')[1], 'base64') });
  await expect(page.locator('#notice')).toContainText('Your picture is ready');
  const download = page.waitForEvent('download'); await page.locator('#save').click();
  expect((await download).suggestedFilename()).toBe('my-santas-sleigh.png');
  await page.locator('#clear').click(); await page.locator('#confirm-clear').click();
  await expect(page.locator('#save')).toBeDisabled(); await page.locator('#undo').click();
  expect(await canvasData(page)).toBe(initial);
});

test('desktop and mobile layouts fit and produce review screenshots', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('artifacts', { recursive: true }); await page.goto('/');
  await expect(page.locator('#controls-panel')).toBeVisible();
  await expect(page.locator('#magic')).toHaveCount(0);
  const orb = await page.locator('#voice').boundingBox(), controls = await page.locator('#controls-panel').boundingBox();
  expect(controls.y).toBeGreaterThan(orb.y + orb.height);
  expect(await page.locator('#drawing').boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 1000 });
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await openTools(page); await page.locator('#starter').click();
  await page.screenshot({ path: 'artifacts/sketch.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('#drawing').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await openTools(page);
  for (const id of ['voice', 'upload', 'colour', 'thickness-button']) await expect(page.locator(`#${id}`)).toBeInViewport();
  const mobileOrb = await page.locator('#voice').boundingBox(), mobileTools = await page.locator('#controls-panel').boundingBox();
  expect(mobileTools.y).toBeGreaterThan(mobileOrb.y + mobileOrb.height);
  expect(errors).toEqual([]);
});

test('orb follows a real audio signal, settles during silence and resets on disconnect', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { AudioOrb } = await import('/voice.js');
    const orb = new AudioOrb(document.getElementById('voice-orb'), { paused: false });
    orb.unlock(); await orb.context.resume();
    const tone = orb.context.createOscillator(), volume = orb.context.createGain(), stream = orb.context.createMediaStreamDestination();
    volume.gain.value = .08; tone.connect(volume); volume.connect(stream); tone.start(); orb.attach(stream.stream);
    window.orbTest = { orb, tone, volume };
  });
  const level = () => page.locator('#voice-orb').evaluate(element => Number(element.style.getPropertyValue('--level')));
  await expect.poll(level).toBeGreaterThan(.1);
  await page.evaluate(() => { orbTest.volume.gain.value = 0; });
  await expect.poll(level).toBeLessThan(.01);
  await page.evaluate(() => { orbTest.tone.stop(); orbTest.orb.dispose(); });
  expect(await level()).toBe(0);
});

test('full reset requires confirmation and clears drawing, notes and voice', async ({ page }) => {
  await mockVoice(page);
  await configured(page);
  await page.locator('#starter').click();
  await page.locator('#voice').click();
  await expect(page.locator('#mute')).toBeVisible();
  await page.locator('#ideas-button').click();
  await page.locator('#notes').fill('Keep the red sleigh');
  await page.locator('#reset-session').click();
  await page.getByRole('button', { name: 'Keep sketchbook' }).click();
  await expect(page.locator('#notes')).toHaveValue('Keep the red sleigh');
  await page.locator('#reset-session').click();
  await page.locator('#confirm-reset').click();
  await expect(page.locator('#ideas-dialog')).toBeHidden();
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#mute')).toBeHidden();
  await page.locator('#ideas-button').click();
  await expect(page.locator('#notes')).toHaveValue('');
});

test('voice recovers when microphone permission is left unanswered', async ({ page }) => {
  await configured(page);
  await page.clock.install();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await page.locator('#starter').click();
  await page.locator('#voice').click();
  await expect(page.locator('#voice-label')).toHaveText('Cancel connection');
  await page.clock.fastForward(46000);
  await expect(page.locator('#notice')).toContainText('Voice took too long');
  await expect(page.locator('#voice-label')).toHaveText('Talk to Santa’s little helper');
  await expect(page.locator('#save')).toBeEnabled();
});
