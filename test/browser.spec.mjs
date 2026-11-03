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
async function configured(page) {
  await page.route('**/api/config', route => route.fulfill({ json: { configured: true, csrfToken: 'test-token', liveModel: 'gpt-live-1', imageModel: 'gpt-image-2' } }));
  await page.goto('/');
  await openTools(page);
  await page.getByRole('button', { name: 'Grown-ups' }).click();
  await page.locator('#adult-test').check();
  await page.getByRole('button', { name: 'Close setup' }).click();
}
async function canvasData(page) { return page.locator('#drawing').evaluate(canvas => canvas.toDataURL()); }

const littleMan = { action: 'draw', message: 'A little man.', strokes: [
  { colour: '#353c3b', width: 5, points: [{x:475,y:300},{x:475,y:270},{x:500,y:250},{x:525,y:270},{x:525,y:300},{x:500,y:320},{x:475,y:300}] },
  { colour: '#353c3b', width: 5, points: [{x:500,y:320},{x:500,y:440},{x:460,y:500}] },
  { colour: '#353c3b', width: 5, points: [{x:500,y:440},{x:540,y:500}] },
  { colour: '#353c3b', width: 5, points: [{x:440,y:350},{x:500,y:370},{x:560,y:350}] },
] };

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
  await page.locator('#setup-button').click(); await page.locator('#preview-snow').click();
  await expect(page.locator('#snow-overlay')).toBeVisible();
  await expect(page.locator('#snow-overlay')).toBeHidden({ timeout: 7000 });
  expect(await canvasData(page)).toBe(initial); expect(paidCalls).toBe(0);
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
  await page.locator('#voice').click(); await expect(page.locator('#voice-label')).toHaveText('Talk to Pip');
  expect(await page.evaluate(() => voiceTest.stopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => voiceTest.sent.some(event => event.type === 'session.close'))).toBe(true);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveMicrophone = resolve; }); });
  await page.locator('#voice').click(); await expect(page.locator('#voice-label')).toHaveText('Cancel connection');
  await page.locator('#voice').click();
  await page.evaluate(() => resolveMicrophone({ getTracks: () => [{ stop() { voiceTest.lateStopped = true; } }] }));
  await expect.poll(() => page.evaluate(() => voiceTest.lateStopped)).toBe(true);
  await expect(page.locator('#voice-label')).toHaveText('Talk to Pip');
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
