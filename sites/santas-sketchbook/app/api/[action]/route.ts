import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { createOpenAI, AppError } from '../../../lib/openai.mjs';
import { validPng, validateCanvasContext } from '../../../lib/validation.mjs';

const origin = 'https://santas-sketchbook-mitch.mitchellrevill.chatgpt.site';
const running = new Set<string>();
const json = (data: unknown, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
function config() {
  const secrets = env as unknown as Record<string, string>;
  return { apiKey: secrets.OPENAI_API_KEY || '', liveModel: 'gpt-live-1.1', drawingModel: 'gpt-6.1-terra', imageModel: 'gpt-image-2' };
}
export async function GET(request: Request) {
  if (!(await getChatGPTUser())) return json({ error: 'Please sign in with ChatGPT.' }, 401);
  if (!new URL(request.url).pathname.endsWith('/config')) return json({ error: 'Not found.' }, 404);
  const previous = request.headers.get('cookie')?.match(/(?:^|;\s*)sketchbook_csrf=([a-f0-9-]{72})(?:;|$)/)?.[1];
  const csrfToken = previous || crypto.randomUUID() + crypto.randomUUID();
  const { apiKey, ...models } = config();
  return json({ ...models, backend: 'openai', configured: Boolean(apiKey), voiceConfigured: Boolean(apiKey), csrfToken }, 200,
    { 'Set-Cookie': `sketchbook_csrf=${csrfToken}; Path=/; HttpOnly; Secure; SameSite=Strict` });
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Please sign in with ChatGPT.' }, 401);
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)sketchbook_csrf=([^;]+)/)?.[1];
  if (request.headers.get('origin') !== origin || !cookie || cookie !== request.headers.get('x-sketchbook-token')) return json({ error: 'Reload the page and try again.' }, 403);
  const action = new URL(request.url).pathname.split('/').at(-1);
  if (!['session', 'draw', 'assess', 'review', 'convert'].includes(action || '')) return json({ error: 'Not found.' }, 404);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Send JSON.' }, 415);
  const task = `${user.userId}:${action === 'session' ? 'voice' : 'picture'}`;
  if (running.has(task)) return json({ error: 'Our friend is already working. Please wait a moment.' }, 429);
  running.add(task);
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new AppError(400, 'Missing request.');
    const chunks: Uint8Array[] = []; let length = 0;
    const limit = action === 'session' ? 70000 : action === 'review' ? 18100000 : 9100000;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > limit) { await reader.cancel(); throw new AppError(413, 'That picture is too large.'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError(400, 'The request could not be read.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Invalid request.');
    const provider = createOpenAI(config());
    if (action === 'session') {
      if (typeof body.sdp !== 'string' || body.sdp.length > 65536 || !body.sdp.startsWith('v=0')) throw new AppError(400, 'Invalid microphone connection.');
      const result = await provider.session(body.sdp);
      if (!result.session?.id || !result.transport?.sdp) throw new AppError(502, 'The voice service did not return a connection. Please try again.');
      return json({ session: { id: result.session?.id }, transport: { sdp: result.transport?.sdp } }, 201);
    }
    if (action === 'convert') {
      if (!validPng(body.image) || typeof body.notes !== 'string' || body.notes.length > 2000 || typeof body.conversation !== 'string' || body.conversation.length > 12000) throw new AppError(400, 'Invalid picture or notes.');
      return json(await provider.convert(body.image, body.notes, body.conversation));
    }
    validateCanvasContext(body, action !== 'draw');
    if (!validPng(body.image, body.snapshot === true || action !== 'draw')) throw new AppError(400, 'Invalid picture.');
    if (action === 'draw') {
      if (!body.conversation.trim() || (body.pointer !== null && (!body.pointer || !['x','y'].every(axis => Number.isFinite(body.pointer[axis]) && body.pointer[axis] >= 0 && body.pointer[axis] <= 1000)))) throw new AppError(400, 'Invalid drawing request.');
      return json(await provider.draw(body));
    }
    if (action === 'review') {
      if (!validPng(body.candidate, true) || atob(body.image.slice(22)).slice(16,24) !== atob(body.candidate.slice(22)).slice(16,24)) throw new AppError(400, 'Invalid drawing preview.');
      return json(await provider.review(body));
    }
    return json(await provider.assess(body));
  } catch (error) {
    const known = error instanceof AppError;
    console.warn('Sketchbook request failed', { action, code: known ? error.code : 'internal_error' });
    return json({ error: known ? error.message : 'Our friend had a problem. Your drawing is safe.', code: known ? error.code : 'internal_error' }, known ? error.status : 500);
  } finally { running.delete(task); }
}
