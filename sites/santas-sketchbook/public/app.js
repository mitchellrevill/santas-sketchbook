import { Drawing, DrawingCursor } from './drawing.js';
import { Snow } from './snow.js';
import { Voice, AudioOrb } from './voice.js';

const $ = id => document.getElementById(id);
let config = null, busy = false;
let transcript = [], transcriptSession = 0;
let operation = null, lastPointer = null, lastHandledTurn = '';
let scene = null, sceneRevision = -1, assessmentTimer, assessmentRequest = null;
let assessmentCount = 0, lastAssessmentAt = 0, lastSuggestionAt = 0;
let noticeTimer;
const notice = (message, error = false) => {
  clearTimeout(noticeTimer); $('notice').hidden = false; $('notice').textContent = message; $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
};
function showProgress(message) {
  clearTimeout(noticeTimer);
  $('notice').hidden = true;
  $('work-status').textContent = message;
  $('work-status').hidden = false;
}
const board = new Drawing($('drawing'), refreshDrawing);
const snow = new Snow($('snow-overlay'), $('snow'));
const orb = new AudioOrb($('voice-orb'), $('voice-audio'));
const cursor = new DrawingCursor(board, $('drawing-cursor'));
function cancelOperation() {
  if (!operation) return;
  showProgress('Stopping our friend…');
  operation.controller.abort();
}
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
  if (sceneRevision >= 0 && sceneRevision !== board.revision) {
    sceneRevision = -1;
    voice.canvasContext({ observation: 'The canvas has changed since the last picture check. Previous visual details may be out of date.', uncertainty: '', plan: [], suggestion: '' });
  }
  scheduleAssessment();
}

function controlExclusions() {
  const canvas = board.canvas.getBoundingClientRect();
  return [...document.querySelectorAll('.voice-card,.toolbar,#caption,#stop-action')]
    .filter(element => !element.hidden && element.getClientRects().length)
    .slice(0, 12).map(element => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(canvas.left, rect.left), top = Math.max(canvas.top, rect.top);
      const right = Math.min(canvas.right, rect.right), bottom = Math.min(canvas.bottom, rect.bottom);
      return { x: (left - canvas.left) / canvas.width * 1000, y: (top - canvas.top) / canvas.height * 1000,
        width: (right - left) / canvas.width * 1000, height: (bottom - top) / canvas.height * 1000 };
    }).filter(rect => rect.width > 0 && rect.height > 0);
}

function scheduleAssessment() {
  clearTimeout(assessmentTimer);
  if (voice.state !== 'active' || busy || operation || assessmentCount >= 6) return;
  const delay = Math.max(1500, 20_000 - (Date.now() - lastAssessmentAt));
  assessmentTimer = setTimeout(() => assessCanvas(), delay);
}

async function assessCanvas() {
  if (assessmentRequest || operation || busy || board.pointer !== null || voice.state !== 'active' || assessmentCount >= 6) return;
  if (!board.hasContent) {
    scene = { observation: 'The canvas is blank.', uncertainty: '', plan: [], suggestion: '' };
    sceneRevision = board.revision;
    voice.canvasContext(scene);
    return;
  }
  const snapshot = board.visionSnapshot(), generation = voice.generation;
  lastAssessmentAt = Date.now(); assessmentCount++;
  assessmentRequest = post('/api/assess', { ...snapshot, exclusions: controlExclusions(),
    conversation: transcriptText(), scene, suggestionAllowed: Date.now() - lastSuggestionAt >= 60_000 }, AbortSignal.timeout(50_000));
  try {
    const result = await assessmentRequest;
    if (voice.generation !== generation || result.revision !== board.revision || board.pointer !== null) return;
    scene = { observation: result.observation, uncertainty: result.uncertainty, plan: result.plan,
      suggestion: Date.now() - lastSuggestionAt >= 60_000 ? result.suggestion : '' };
    sceneRevision = result.revision;
    if (scene.suggestion) lastSuggestionAt = Date.now();
    voice.canvasContext(scene);
  } catch {
    // Observation is optional: failure must not interrupt the child's drawing.
  } finally {
    assessmentRequest = null;
    if (voice.generation !== generation || board.revision !== snapshot.revision) scheduleAssessment();
  }
}

async function waitForAssessment(signal) {
  if (!assessmentRequest) return;
  let onAbort;
  try {
    await Promise.race([
      assessmentRequest.catch(() => {}),
      new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
function setBusy(value) {
  busy = value; board.locked = value;
  for (const input of document.querySelectorAll('.toolbar button,.toolbar input,#starter,#preview-snow')) input.disabled = value;
  refreshDrawing();
}
async function refreshConfig() {
  const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (response.status === 401 || response.redirected) throw new Error('Your sign-in expired. Save your picture, then reload to sign in.');
  if (!response.ok) throw new Error('The sketchbook could not connect. Try again in a moment.');
  config = await response.json();
  $('demo-request-form').hidden = config.backend !== 'codex';

}
async function ensureAI() {
  try { await refreshConfig(); }
  catch (error) { notice(error.message, true); return false; }
  if (!config.configured) { notice('Our drawing friend cannot connect just now. You can keep drawing.', true); return false; }
  return true;
}
async function post(path, body, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sketchbook-Token': config.csrfToken },
    body: JSON.stringify(body), signal });
  if (response.status === 401 || response.redirected) throw new Error('Your sign-in expired. Save your picture, then reload to sign in.');
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('The sketchbook received an unreadable reply. Please try again.');
  if (!response.ok) throw new Error(data.error || 'The request could not finish. Your drawing is safe.');
  return data;
}

function transcriptText() { return transcript.map(item => `${item.speaker}: ${item.text}`).join('\n').slice(-12000); }
const voice = new Voice({ audio: $('voice-audio'), post,
  onDelegation: id => handleDelegation(id),
  onAudio: stream => orb.attach(stream),
  onState(state, muted) {
    $('voice-label').textContent = { idle: 'Talk to Santa’s little helper', connecting: 'Cancel connection', active: 'Finish talking', stopping: 'Finishing…' }[state];
    $('voice-state').textContent = { idle: 'Your AI idea helper', connecting: 'Getting the microphone ready', active: muted ? 'Microphone paused' : 'Microphone on · Santa’s little helper is listening', stopping: 'Microphone off' }[state];
    $('voice').disabled = state === 'stopping';
    const label = state === 'idle' ? 'Talk to Santa’s little helper' : `${$('voice-label').textContent} · ${$('voice-state').textContent}`;
    $('voice').setAttribute('aria-label', label); $('voice').title = label;
    const card = document.querySelector('.voice-card');
    card.classList.toggle('active', state === 'active'); card.classList.toggle('muted', muted); card.classList.toggle('connecting', state === 'connecting');
    if (state === 'idle' || state === 'stopping') {
      orb.detach();
      if (operation?.kind !== 'convert') cancelOperation();
      clearTimeout(assessmentTimer);
    }
    if (state === 'active') scheduleAssessment();
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
    if (speaker === 'Santa’s little helper') { $('caption').hidden = false; $('caption').textContent = transcript.at(-1).text.slice(-260); }
  }, onError: message => notice(message, true),
});
function transcriptTextLength() { return transcript.reduce((total, item) => total + item.text.length, 0); }

$('voice').addEventListener('click', async () => {
  if (voice.state !== 'idle') { voice.stop(); return; }
  orb.unlock();
  await voice.start(async () => {
    await refreshConfig();
    if (!config.voiceConfigured) throw new Error('Voice is unavailable. You can still use the drawing tools.');
    transcriptSession++;
    assessmentCount = 0;
    lastAssessmentAt = 0;
    lastSuggestionAt = 0;
    scene = null;
    sceneRevision = -1;
  });
});
$('mute').addEventListener('click', () => voice.toggleMute());
$('ideas-button').addEventListener('click', () => $('ideas-dialog').showModal());
$('demo-request-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('demo-request').value.trim();
  if (!text || busy || operation) return;
  if (!(await ensureAI())) return;
  const now = Date.now();
  transcript.push({ speaker: 'You', text, start: now, end: now, received: now, session: transcriptSession });
  while (transcript.length > 80) transcript.shift();
  $('transcript').textContent = transcriptText();
  $('demo-request').value = '';
  $('ideas-dialog').close();
  await handleDelegation(`typed-${now}`);
});
$('reset-session').addEventListener('click', () => $('reset-dialog').showModal());
$('confirm-reset').addEventListener('click', () => {
  cancelOperation();
  voice.cleanup();
  $('notes').value = '';
  $('demo-request').value = '';
  $('include-conversation').checked = true;
  window.location.reload();
});
$('forget').addEventListener('click', () => {
  cancelOperation(); voice.cleanup(); scene = null; sceneRevision = -1; transcript = []; $('transcript').textContent = 'Your conversation will appear here.';
  $('caption').hidden = true; notice('Conversation cleared. Your picture is still here.');
});

function selectTool(tool) {
  board.tool = tool;
  for (const name of ['pen', 'eraser', 'fill']) { $(name).classList.toggle('selected', tool === name); $(name).setAttribute('aria-pressed', String(tool === name)); }
}
for (const tool of ['pen', 'eraser', 'fill']) $(tool).addEventListener('click', () => selectTool(tool));
function selectColour(colour) {
  board.colour = colour; $('colour').value = colour; selectTool(board.tool === 'fill' ? 'fill' : 'pen');
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
  try { await board.upload(file); notice('Your picture is ready. Draw on it, or dream up a change with Santa’s little helper.'); }
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
  operation = op; clearTimeout(assessmentTimer); $('stop-action').hidden = false;
  showProgress('Our friend is getting ready…');
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
    if (assessmentRequest) showProgress('Our friend is looking at your drawing…');
    await waitForAssessment(signal);
    signal.throwIfAborted();
    const snapshot = board.visionSnapshot(), exclusions = controlExclusions();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (board.revision !== snapshot.revision || board.pointer !== null) throw new Error('Your drawing changed while Santa’s little helper was thinking. Nothing was added; ask again when you are ready.');
    };
    showProgress('Our friend is planning your picture…');
    const context = { ...snapshot, snapshot: true, conversation, exclusions, scene: sceneRevision === snapshot.revision ? scene : null };
    let plan, repair = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      plan = await post('/api/draw', { ...context, pointer: lastPointer, repair }, signal);
      assertCurrent();
      if (repair && plan.action !== repair.previousPlan.action) throw new Error('Our friend could not revise that change. Your picture is unchanged.');
      if (!['draw', 'erase'].includes(plan.action)) {
        if (repair) throw new Error('Santa’s little helper could not revise that drawing. Nothing was changed.');
        break;
      }
      let feedback = '';
      let candidate;
      try { candidate = board.preview(plan.strokes, exclusions); }
      catch (error) { feedback = error.message; }
      if (!feedback) {
        showProgress('Our friend is checking the shapes…');
        const review = await post('/api/review', { ...context, candidate }, signal);
        assertCurrent();
        if (review.revision !== snapshot.revision) throw new Error('The drawing check is out of date. Nothing was changed.');
        if (!review.approved) feedback = review.message || 'The requested object was not recognisable or did not fit the scene.';
      }
      if (!feedback) break;
      if (attempt === 1) throw new Error('Santa’s little helper could not make that drawing fit well after revising it. Nothing was changed.');
      repair = { previousPlan: plan, feedback: feedback.slice(0, 500) };
      showProgress('Our friend is improving the shapes and placement…');
    }
    assertCurrent();
    if (['draw', 'erase'].includes(plan.action)) {
      setBusy(true);
      showProgress(plan.action === 'erase' ? 'Our friend is removing that part…' : 'Our friend is drawing your picture…');
      await cursor.draw(plan.strokes, signal);
      scene = null; sceneRevision = -1;
      report(`The requested pen drawing was visually checked, then completed successfully: ${plan.message}. It can be undone in one step.`);
      notice('There you go! You can add to it or Undo.');
    } else if (plan.action === 'undo') {
      const available = board.history.length > 0;
      board.undo();
      report(available ? 'The last change was undone successfully.' : 'There are no earlier changes to undo.');
      notice(available ? 'Back one step!' : 'We are at the beginning of this picture.');
    } else if (plan.action === 'convert') {
      if (!board.hasContent) { report('The page is blank. Ask them to draw or add a picture first.'); notice('Draw a little something first.'); return; }
      op.kind = 'convert';
      setBusy(true);
      payload.image = board.export();
      payload.notes = $('notes').value;
      payload.conversation = $('include-conversation').checked ? transcriptText() : '';
      showProgress('Our friend is bringing your picture to life…');
      report('The requested photo conversion is starting. Wait for the completion result before saying it is ready.');
      await snow.start(); signal.throwIfAborted();
      const result = await post('/api/convert', payload, signal); signal.throwIfAborted();
      showProgress('Your picture is ready! Bringing it back…');
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
    if (operation === op) {
      operation = null; $('stop-action').hidden = true;
      $('work-status').hidden = true;
      setBusy(false); scheduleAssessment();
    }
  }
}
$('preview-snow').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try { await snow.start(true); await new Promise(resolve => setTimeout(resolve, 1800)); await snow.reveal(() => {}); notice('Snowfall preview finished. No AI call was made and your picture is unchanged.'); }
  finally { setBusy(false); }
});
window.addEventListener('pagehide', () => { voice.stop(); voice.cleanup(); orb.dispose(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) voice.stop(); });
refreshDrawing();
refreshConfig().catch(error => notice(error.message, true));
