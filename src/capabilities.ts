import type { ProviderCapabilities } from '@archon/provider-contract';
import { QWEN_KNOWN_TOOL_NAMES } from './tools';

export const PROVIDER_ID = 'qwen';

/**
 * Only what this provider enforces. See README "Capabilities" for the reasoning behind
 * each `false`.
 */
export const capabilities: ProviderCapabilities = {
  // Qwen Code can start background shells and sub-agents whose lifecycle stream-json does
  // not report.
  backgroundWork: 'unobserved',
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  plugins: false,
  agents: false,
  toolRestrictions: true,
  knownToolNames: QWEN_KNOWN_TOOL_NAMES,
  // `--json-schema` asks for a validated `structured_output` tool call, but decoding is not
  // grammar-constrained; Archon validates and re-asks.
  structuredOutput: 'best-effort',
  requiresAllPropertiesRequired: false,
  envInjection: true,
  costControl: false,
  costReporting: false,
  tokenReporting: true,
  stopReasonReporting: true,
  turnCountReporting: true,
  resolvedModelReporting: true,
  effortControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};
