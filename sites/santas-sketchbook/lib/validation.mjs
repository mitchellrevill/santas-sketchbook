import { Buffer } from 'node:buffer';
import { AppError } from './errors.mjs';
import { validateScene } from './scene.mjs';
import { validateDrawingPlan } from './drawing-agent.mjs';
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


export { validPng, validateCanvasContext };
