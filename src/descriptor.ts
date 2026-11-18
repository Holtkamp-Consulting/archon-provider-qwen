import { z } from 'zod';
import { PROVIDER_PLUGIN_PROTOCOL, providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { capabilities, PROVIDER_ID } from './capabilities';
import pkg from '../package.json' with { type: 'json' };

const configSchema = z.strictObject({
  /** Qwen Code model id (`--model`). Omit to use the model selected in ~/.qwen/settings.json. */
  model: z.string().min(1).optional(),
});

export const descriptor = providerPluginDescriptorSchema.parse({
  protocol: PROVIDER_PLUGIN_PROTOCOL,
  id: PROVIDER_ID,
  displayName: 'Qwen Code',
  version: pkg.version,
  capabilities,
  // Native auth only: Qwen Code reads its own settings.json and environment.
  credentials: { kind: 'static', specs: [] },
  configSchema: z.toJSONSchema(configSchema, { io: 'input' }),
});
