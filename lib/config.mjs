import { readFileSync } from 'node:fs';

// Re-read this project's local .env so secure setup needs no restart.
export function readConfig() {
  const local = {};
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const get = name => process.env[name] || local[name] || '';
  return { apiKey: get('OPENAI_API_KEY'), organisation: get('OPENAI_ORG_ID'),
    project: get('OPENAI_PROJECT_ID'), port: Number(get('PORT') || 3017),
    liveModel: 'gpt-live-1', imageModel: 'gpt-image-2', drawingModel: 'gpt-6-luna' };
}
