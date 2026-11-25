import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readConfig } from './lib/config.mjs';
import { AppError, createOpenAI } from './lib/openai.mjs';
import { validateScene } from './lib/scene.mjs';
import { createCodex } from './lib/codex.mjs';
import { validateDrawingPlan } from './lib/drawing-agent.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ...['app', 'drawing', 'voice', 'snow'].map(name => [`/${name}.js`, [`${name}.js`, 'text/javascript; charset=utf-8']]),
]);

async function readJson(request, limit) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'Send JSON.');
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new AppError(413, 'That picture is too large. Try a smaller one.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  }
  catch { throw new AppError(400, 'The request could not be read.'); }
}

function validPng(image, snapshot = false) {
  if (typeof image !== 'string' || image.length > 9_000_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return false;
  const bytes = Buffer.from(image.slice(22), 'base64');
  if (bytes.length <= 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.toString('ascii',12,16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return snapshot ? width >= 1 && height >= 1 && width <= 1024 && height <= 1024 : width === 1536 && height === 1024;
}

function validateCanvasContext(body, requireRevision = false) {
  if (!body.viewport || !['width', 'height'].every(axis => Number.isInteger(body.viewport[axis]) && body.viewport[axis] > 0 && body.viewport[axis] <= 8192)) throw new AppError(400, 'Invalid drawing page dimensions.');
  const exclusions = body.exclusions ?? [];
  if (!Array.isArray(exclusions) || exclusions.length > 12 || exclusions.some(rect => !rect
    || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1000)
    || rect.width === 0 || rect.height === 0 || rect.x + rect.width > 1000.01 || rect.y + rect.height > 1000.01)) throw new AppError(400, 'Invalid control locations.');
  if (typeof body.conversation !== 'string' || body.conversation.length > 12000) throw new AppError(400, 'The conversation is too long.');
  if (requireRevision && (!Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision > 1_000_000_000)) throw new AppError(400, 'Invalid canvas revision.');
  if (body.suggestionAllowed !== undefined && typeof body.suggestionAllowed !== 'boolean') throw new AppError(400, 'Invalid suggestion preference.');
  if (body.inkMap !== undefined && (!Array.isArray(body.inkMap) || body.inkMap.length !== 20
    || body.inkMap.some(row => typeof row !== 'string' || !/^[.#]{20}$/.test(row)))) throw new AppError(400, 'Invalid canvas coordinate map.');
  if (body.repair != null) {
    if (typeof body.repair.feedback !== 'string' || !body.repair.feedback.trim() || body.repair.feedback.length > 500) throw new AppError(400, 'Invalid drawing feedback.');
    try {
      const previousPlan = validateDrawingPlan(body.repair.previousPlan);
      if (!['draw', 'erase'].includes(previousPlan.action)) throw new Error('Expected a drawing.');
      body.repair = { previousPlan, feedback: body.repair.feedback };
    } catch { throw new AppError(400, 'Invalid previous drawing plan.'); }
  }
  if (body.scene != null) {
    try { body.scene = validateScene(body.scene); }
    catch { throw new AppError(400, 'Invalid scene observations.'); }
  }
  if (body.snapshot === true || requireRevision) {
    if (!validPng(body.image, true)) throw new AppError(400, 'Invalid canvas snapshot.');
    const bytes = Buffer.from(body.image.slice(22), 'base64');
    const scale = Math.min(1024 / body.viewport.width, 1024 / body.viewport.height, 1);
    if (Math.abs(bytes.readUInt32BE(16) - Math.round(body.viewport.width * scale)) > 1
      || Math.abs(bytes.readUInt32BE(20) - Math.round(body.viewport.height * scale)) > 1) throw new AppError(400, 'The snapshot does not match the drawing page.');
  }
}

export function createApp({ getConfig = readConfig, fetchImpl = fetch, codexFactory = createCodex } = {}) {
  const token = randomBytes(32).toString('hex');
  let codex;
  const codexProvider = config => codex ||= codexFactory(config);
  let conversionBusy = false, drawingBusy = false, sessionBusy = false, visionBusy = false;
  let lastConversion = 0, lastSession = 0, lastAssessment = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(self)');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const port = server.address()?.port;
      if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(request.headers.host)) throw new AppError(403, 'Local access only.');
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (request.method === 'GET' && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        const file = await readFile(new URL(name, publicRoot));
        response.writeHead(200, { 'Content-Type': type }); response.end(file); return;
      }
      if (request.method === 'GET' && pathname === '/api/config') {
        const config = getConfig();
        const demo = config.backend === 'codex';
        if (demo) await codexProvider(config).status();
        json(200, { configured: demo || Boolean(config.apiKey), voiceConfigured: Boolean(config.apiKey), csrfToken: token,
          backend: demo ? 'codex' : 'openai', liveModel: config.liveModel,
          imageModel: demo ? 'Codex native image generation' : config.imageModel,
          drawingModel: config.drawingModel || 'gpt-6.1-terra' }); return;
      }
      if (request.method !== 'POST' || !['/api/session', '/api/convert', '/api/draw', '/api/assess', '/api/review'].includes(pathname)) throw new AppError(404, 'Not found.');
      if (request.headers.origin !== `http://${request.headers.host}`) throw new AppError(403, 'Unexpected request origin.');
      const supplied = Buffer.from(request.headers['x-sketchbook-token'] || '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) throw new AppError(403, 'Reload the page and try again.');
      const body = await readJson(request, pathname === '/api/session' ? 70_000 : pathname === '/api/review' ? 18_100_000 : 9_100_000);
      const config = getConfig();
      const provider = config.backend === 'codex' && pathname !== '/api/session'
        ? codexProvider(config) : createOpenAI(config, fetchImpl);
      if (pathname === '/api/session') {
        if (typeof body.sdp !== 'string' || body.sdp.length > 65_536 || !body.sdp.startsWith('v=0')) throw new AppError(400, 'A valid microphone connection offer is required.');
        if (sessionBusy || Date.now() - lastSession < 10_000) throw new AppError(429, 'Please wait a moment before starting another conversation.');
        sessionBusy = true;
        try {
          const result = await provider.session(body.sdp);
          if (!result.session?.id || !result.transport?.sdp) throw new AppError(502, 'OpenAI did not return a voice connection.');
          lastSession = Date.now();
          json(201, { session: { id: result.session.id }, transport: { type: 'webrtc', sdp: result.transport.sdp } });
        } finally { sessionBusy = false; }
      } else if (pathname === '/api/assess' || pathname === '/api/review') {
        validateCanvasContext(body, true);
        if (pathname === '/api/review') {
          if (!validPng(body.candidate, true)) throw new AppError(400, 'Invalid drawing preview.');
          const original = Buffer.from(body.image.slice(22), 'base64');
          const candidate = Buffer.from(body.candidate.slice(22), 'base64');
          if (!original.subarray(16, 24).equals(candidate.subarray(16, 24))) throw new AppError(400, 'The drawing preview dimensions do not match.');
        }
        if (visionBusy || conversionBusy || drawingBusy) throw new AppError(429, 'The picture helper is busy. Keep drawing and try again later.');
        if (pathname === '/api/assess' && Date.now() - lastAssessment < 5000) throw new AppError(429, 'Please leave a little time between picture checks.');
        visionBusy = true;
        if (pathname === '/api/assess') lastAssessment = Date.now();
        try { json(200, pathname === '/api/assess' ? await provider.assess(body) : await provider.review(body)); }
        finally { visionBusy = false; }
      } else if (pathname === '/api/draw') {
        if (!validPng(body.image, body.snapshot === true) || typeof body.conversation !== 'string' || !body.conversation.trim()) throw new AppError(400, 'A drawing and a clear drawing request are required.');
        validateCanvasContext(body);
        if (body.pointer !== null && (!body.pointer || !['x','y'].every(axis => Number.isFinite(body.pointer[axis]) && body.pointer[axis] >= 0 && body.pointer[axis] <= 1000))) throw new AppError(400, 'Invalid drawing location.');
        if (drawingBusy || conversionBusy) throw new AppError(429, 'The page is already being updated. Please wait a moment.');
        drawingBusy = true;
        try { json(200, await provider.draw(body)); }
        finally { drawingBusy = false; }
      } else {
        if (!validPng(body.image)) throw new AppError(400, 'Please submit a picture from the drawing canvas.');
        if (typeof body.notes !== 'string' || body.notes.length > 2000 || typeof body.conversation !== 'string' || body.conversation.length > 12000) throw new AppError(400, 'The idea notes are too long.');
        if (conversionBusy || drawingBusy || Date.now() - lastConversion < 5000) throw new AppError(429, 'One picture at a time. Please wait a moment.');
        conversionBusy = true;
        try { json(200, await provider.convert(body.image, body.notes, body.conversation)); lastConversion = Date.now(); }
        finally { conversionBusy = false; }
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'Something went wrong. Your drawing is safe.',
        code: error instanceof AppError ? error.code : 'internal_error',
      });
      // Never log bodies, transcripts, pictures or raw provider errors.
      if (!(error instanceof AppError)) console.error('Local request failed:', error.name);
      else if (error.status >= 500 || error.status === 429) console.warn('Request failed:', JSON.stringify({
        route: new URL(request.url, 'http://localhost').pathname,
        status: error.status, code: error.code,
      }));
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.on('close', () => codex?.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid PORT.');
  createApp().listen(config.port, '127.0.0.1', () => {
    console.log(`Santa's Sketchbook: http://localhost:${config.port}`);
    if (config.backend === 'codex') console.log('Codex demo: helper and images use the existing ChatGPT login. Voice still uses the OpenAI API.');
    console.log(config.apiKey ? 'OpenAI key configured; model access needs a live check.' : 'Drawing ready. Connect OpenAI using setup.ps1 to enable AI.');
  });
}
