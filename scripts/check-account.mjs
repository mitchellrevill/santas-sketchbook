import { readConfig } from '../lib/config.mjs';
import { createOpenAI } from '../lib/openai.mjs';
const config = readConfig();
try {
  const result = await createOpenAI(config).models();
  const ids = new Set(result.data.map(model => model.id));
  for (const model of [config.liveModel, config.imageModel, config.drawingModel]) console.log(`${model}: ${ids.has(model) ? 'listed for this key' : 'not listed for this key'}`);
  console.log('Listing is not proof that generation will succeed. Billing balance is not available from this check. No voice or image generation was requested.');
  if (![config.liveModel, config.imageModel, config.drawingModel].every(model => ids.has(model))) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
