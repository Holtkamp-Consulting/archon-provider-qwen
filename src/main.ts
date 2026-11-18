import { serveProvider } from '@archon/provider-contract/plugin';
import { descriptor } from './descriptor';
import { QwenProvider } from './provider';

export { descriptor };
export const create = (): QwenProvider => new QwenProvider();

if (import.meta.main) {
  await serveProvider({ descriptor, create: log => new QwenProvider(log) });
}
