import { Drawing, DrawingCursor } from './drawing.js';
import { Snow } from './snow.js';
import { Voice, AudioOrb } from './voice.js';

const $ = id => document.getElementById(id);
let config = null, busy = false, adultTest = false;
let transcript = [], transcriptSession = 0;
let operation = null, lastPointer = null, lastHandledTurn = '';
let noticeTimer;
const notice = (message, error = false) => {
  clearTimeout(noticeTimer); $('notice').hidden = false; $('notice').textContent = message; $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
};
const board = new Drawing($('drawing'), refreshDrawing);
const snow = new Snow($('snow-overlay'), $('snow'));
const orb = new AudioOrb($('voice-orb'), $('voice-audio'));
const cursor = new DrawingCursor(board, $('drawing-cursor'));
function cancelOperation() { operation?.controller.abort(); }
board.beforeResize = cancelOperation;
$('stop-action').addEventListener('click', cancelOperation);
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelOperation(); });
$('drawing').addEventListener('pointermove', event => {
  const bounds = board.canvas.getBoundingClientRect();
  lastPointer = { x: Math.max(0, Math.min(1000, (event.clientX - bounds.left) / bounds.width * 1000)), y: Math.max(0, Math.min(1000, (event.clientY - bounds.top) / bounds.height * 1000)) };
});

function refreshDrawing() {
  $('undo').disabled = busy || !board.history.length;
  $('save').disabled = busy || !board.hasContent;
}
function setBusy(value) {
  busy = value; board.locked = value;
  for (const input of document.querySelectorAll('.toolbar button,.toolbar input,#starter,#preview-snow')) input.disabled = value;
  refreshDrawing();
}
async function refreshConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('The local server is not responding.');
  config = await response.json();
  $('connection-dot').classList.toggle('ready', config.configured);
  $('connection-dot').title = config.configured ? 'OpenAI key configured; account access not yet verified' : 'OpenAI setup needed';
  $('setup-status').textContent = config.configured ? 'Your API key is configured. Live model access and credits are checked when you use a feature.' : 'Drawing is ready. Connect your OpenAI API key to turn on voice and image magic.';
}
async function ensureAI() {
  try { await refreshConfig(); }
  catch (error) { notice(error.message, true); return false; }
  if (!config.configured || !adultTest) { $('setup-dialog').showModal(); return false; }
  return true;
}
async function post(path, body, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sketchbook-Token': config.csrfToken },
    body: JSON.stringify({ ...body, adultTest }), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not finish. Your drawing is safe.');
  return data;
}

function transcriptText() { return transcript.map(item => `${item.speaker}: ${item.text}`).join('\n').slice(-12000); }
const voice = new Voice({ audio: $('voice-audio'), post,
  onDelegation: id => handleDelegation(id),
  onAudio: stream => orb.attach(stream),
  onState(state, muted) {
    $('voice-label').textContent = { idle: 'Talk to Pip', connecting: 'Cancel connection', active: 'Finish talking', stopping: 'Finishing…' }[state];
    $('voice-state').textContent = { idle: 'Your AI idea helper', connecting: 'Getting the microphone ready', active: muted ? 'Microphone paused' : 'Microphone on · Pip is listening', stopping: 'Microphone off' }[state];
    $('voice').disabled = state === 'stopping';
    const label = state === 'idle' ? 'Talk to the AI · GPT-Live-1' : `${$('voice-label').textContent} · ${$('voice-state').textContent}`;
    $('voice').setAttribute('aria-label', label); $('voice').title = label;
    const card = document.querySelector('.voice-card');
    card.classList.toggle('active', state === 'active'); card.classList.toggle('muted', muted); card.classList.toggle('connecting', state === 'connecting');
    if (state === 'idle' || state === 'stopping') { orb.detach(); cancelOperation(); }
    $('mute').hidden = state !== 'active'; $('mute').textContent = muted ? 'Unmute mic' : 'Mute mic';
  },
  onTranscript(speaker, delta, start, end) {
    const previous = transcript.at(-1);
    if (previous?.speaker === speaker && previous.session === transcriptSession && start - previous.end < 3000) { previous.text += delta; previous.end = end; }
    else transcript.push({ speaker, text: delta, start, end, session: transcriptSession });
    transcript.at(-1).received = Date.now();
    // Bound in-memory context and preserve the exact spaces in each delta.
    while (transcript.length > 80 || (transcript.length > 1 && transcriptTextLength() > 12000)) transcript.shift();
    if (transcript[0]?.text.length > 12000) transcript[0].text = transcript[0].text.slice(-12000);
    $('transcript').textContent = transcriptText();
    if (speaker === 'Pip') { $('caption').hidden = false; $('caption').textContent = transcript.at(-1).text.slice(-260); }
  }, onError: message => notice(message, true),
});
function transcriptTextLength() { return transcript.reduce((total, item) => total + item.text.length, 0); }

$('voice').addEventListener('click', async () => {
  if (voice.state !== 'idle') { voice.stop(); return; }
  orb.unlock();
  if (await ensureAI()) { transcriptSession++; voice.start(); }
});
$('mute').addEventListener('click', () => voice.toggleMute());
$('adult-test').addEventListener('change', event => { adultTest = event.target.checked; if (!adultTest) voice.stop(); });
$('setup-button').addEventListener('click', () => { $('setup-dialog').showModal(); refreshConfig().catch(error => notice(error.message, true)); });
$('refresh-config').addEventListener('click', () => refreshConfig().catch(error => notice(error.message, true)));
$('ideas-button').addEventListener('click', () => $('ideas-dialog').showModal());
$('forget').addEventListener('click', () => {
  voice.stop(); transcript = []; $('transcript').textContent = 'Your conversation will appear here.';
  $('caption').hidden = true; notice('Conversation cleared. Your picture is still here.');
});

function selectTool(tool) {
  board.tool = tool;
  for (const name of ['pen', 'eraser']) { $(name).classList.toggle('selected', tool === name); $(name).setAttribute('aria-pressed', String(tool === name)); }
}
for (const tool of ['pen', 'eraser']) $(tool).addEventListener('click', () => selectTool(tool));
function selectColour(colour) {
  board.colour = colour; $('colour').value = colour; selectTool('pen');
  for (const swatch of document.querySelectorAll('.swatch')) { const selected = swatch.dataset.colour === colour; swatch.classList.toggle('selected', selected); swatch.setAttribute('aria-pressed', String(selected)); }
}
$('swatches').addEventListener('click', event => { if (event.target.dataset.colour) selectColour(event.target.dataset.colour); });
$('colour').addEventListener('input', event => selectColour(event.target.value));
$('thickness-button').addEventListener('click', () => { const open = $('thickness-panel').hidden; $('thickness-panel').hidden = !open; $('thickness-button').setAttribute('aria-expanded', String(open)); });
$('thickness').addEventListener('input', event => { board.thickness = Number(event.target.value); $('thickness-value').value = event.target.value; $('brush-dot').style.width = $('brush-dot').style.height = `${Math.max(4, board.thickness / 2)}px`; });
document.addEventListener('pointerdown', event => { if (!event.target.closest('.thickness')) { $('thickness-panel').hidden = true; $('thickness-button').setAttribute('aria-expanded', 'false'); } });
$('undo').addEventListener('click', () => board.undo());
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.matches('input,textarea') && !document.querySelector('dialog[open]')) { event.preventDefault(); board.undo(); }
});
$('starter').addEventListener('click', () => { board.starter(); notice('A little start! Add your own colours, presents and wonderful ideas.'); });
$('upload').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  setBusy(true);
  try { await board.upload(file); notice('Your picture is ready. Draw on it, or dream up a change with Pip.'); }
  catch (error) { notice(error.message, true); }
  finally { event.target.value = ''; setBusy(false); }
});
$('clear').addEventListener('click', () => { if (board.hasContent) $('clear-dialog').showModal(); });
$('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
$('confirm-clear').addEventListener('click', () => {
  board.clear(); $('clear-dialog').close(); notice('A fresh page for your next big idea.');
  voice.context('The participant cleared their canvas and is starting a new drawing. Ask what they would like to change.');
});
$('save').addEventListener('click', () => {
  if (!board.hasContent || busy) return;
  const link = document.createElement('a'); link.href = board.export(); link.download = 'my-santas-sleigh.png'; link.click();
});

async function handleDelegation(id) {
  if (operation) {
    cancelOperation(); voice.context('The current action was cancelled. Ask what they would like to do next.', id); return;
  }
  if (busy || board.pointer !== null) { voice.context('The page is busy. Ask them to finish their stroke and try again.', id); return; }
  const op = { controller: new AbortController(), generation: voice.generation };
  operation = op; setBusy(true); $('stop-action').hidden = false;
  const signal = AbortSignal.any([op.controller.signal, AbortSignal.timeout(260_000)]);
  const report = message => { if (voice.generation === op.generation) voice.context(message, id); };
  try {
    // The final transcript fragment can arrive just after the delegation event.
    await new Promise(resolve => setTimeout(resolve, 350)); signal.throwIfAborted();
    const turns = transcript.filter(item => item.session === transcriptSession);
    const latest = turns.findLast(item => item.speaker === 'You');
    const turnKey = latest && `${transcriptSession}:${latest.start}:${latest.end}:${latest.text}`;
    if (!latest || Date.now() - latest.received > 15000 || turnKey === lastHandledTurn) {
      report('No new participant request was received. Ask them what they would like you to do.'); return;
    }
    lastHandledTurn = turnKey;
    const conversation = turns.map(item => `${item.speaker}: ${item.text}`).join('\n').slice(-12000);
    const payload = { image: board.export(), notes: $('notes').value, conversation: $('include-conversation').checked ? transcriptText() : '' };
    notice('Pip is thinking…');
    const plan = await post('/api/draw', { image: payload.image, conversation, viewport: { width: Math.round(innerWidth), height: Math.round(innerHeight) }, pointer: lastPointer }, signal);
    signal.throwIfAborted();
    if (plan.action === 'draw') {
      notice('Pip is drawing…');
      await cursor.draw(plan.strokes, signal);
      report(`The requested pen drawing completed successfully: ${plan.message}. It can be undone in one step.`);
      notice('There you go! You can add to it or Undo.');
    } else if (plan.action === 'convert') {
      if (!board.hasContent) { report('The page is blank. Ask them to draw or add a picture first.'); notice('Draw a little something first.'); return; }
      notice('Here comes the snow…');
      report('The requested photo conversion is starting. Wait for the completion result before saying it is ready.');
      await snow.start(); signal.throwIfAborted();
      const result = await post('/api/convert', payload, signal); signal.throwIfAborted();
      const picture = await board.decode(result.image); signal.throwIfAborted();
      const before = { image: board.ctx.getImageData(0, 0, board.canvas.width, board.canvas.height), hasContent: board.hasContent };
      const history = [...board.history];
      await snow.reveal(() => {
        signal.throwIfAborted(); board.replace(picture);
        op.rollback = () => { board.history = history; board.restore(before); };
      });
      signal.throwIfAborted(); op.rollback = null;
      report('The app successfully replaced the canvas with the returned photo. You cannot see the result. Invite them to describe it.');
      notice('Look what you imagined!');
    } else {
      report(`No change was made. ${plan.message}`); notice(plan.message || 'Your picture is unchanged.');
    }
  } catch (error) {
    op.rollback?.();
    await snow.stop();
    const cancelled = error.name === 'AbortError';
    notice(cancelled ? 'Stopped. Your picture is safe.' : error.name === 'TimeoutError' ? 'That took too long. Your picture is safe.' : error.message, !cancelled);
    report(cancelled ? 'The action was cancelled. The original drawing is unchanged.' : 'The action failed. The original drawing is unchanged. Do not claim success.');
  } finally {
    if (operation === op) { operation = null; $('stop-action').hidden = true; setBusy(false); }
  }
}
$('preview-snow').addEventListener('click', async () => {
  if (busy) return;
  $('setup-dialog').close(); setBusy(true);
  try { await snow.start(true); await new Promise(resolve => setTimeout(resolve, 1800)); await snow.reveal(() => {}); notice('Snowfall preview finished. No AI call was made and your picture is unchanged.'); }
  finally { setBusy(false); }
});
window.addEventListener('pagehide', () => { voice.stop(); voice.cleanup(); orb.dispose(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) voice.stop(); });
refreshDrawing();
refreshConfig().catch(error => notice(error.message, true));
