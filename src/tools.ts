/**
 * Tool names Qwen Code 0.24.x registers in headless mode (from the `tools` list of its
 * `system/init` event). Used for advisory validation of `allowed_tools`/`denied_tools`
 * and to turn an allowlist into an exact set: `--core-tools` alone leaves always-on
 * tools such as `agent`, `skill` and `tool_call` enabled, so every known tool outside the
 * allowlist is also passed to `--exclude-tools`. The provider then checks the tool list
 * Qwen Code reports at startup and fails the turn if it differs.
 */
export const QWEN_KNOWN_TOOL_NAMES = [
  'agent',
  'cron_create',
  'cron_delete',
  'cron_list',
  'edit',
  'enter_worktree',
  'exit_worktree',
  'get_goal',
  'glob',
  'grep_search',
  'list_agents',
  'loop_wakeup',
  'monitor',
  'notebook_edit',
  'read_file',
  'read_mcp_resource',
  'record_artifact',
  'report_findings',
  'run_shell_command',
  'send_message',
  'skill',
  'task_stop',
  'tool_call',
  'tool_search',
  'update_goal',
  'web_fetch',
  'write_file',
  'zoom_image',
] as const;

/** Synthetic tool Qwen Code registers for `--json-schema`; never subject to restrictions. */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

export interface ToolRestrictions {
  allowed?: readonly string[];
  denied?: readonly string[];
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function toolRestrictionsFrom(nodeConfig: Record<string, unknown> | undefined): ToolRestrictions {
  const restrictions: ToolRestrictions = {};
  const allowed = stringList(nodeConfig?.allowed_tools);
  const denied = stringList(nodeConfig?.denied_tools);
  if (allowed) restrictions.allowed = allowed;
  if (denied) restrictions.denied = denied;
  return restrictions;
}

export function toolRestrictionArgs(restrictions: ToolRestrictions): string[] {
  const args: string[] = [];
  const excluded = new Set<string>(restrictions.denied ?? []);
  if (restrictions.allowed) {
    for (const name of restrictions.allowed) args.push('--core-tools', name);
    const allowed = new Set(restrictions.allowed);
    for (const name of QWEN_KNOWN_TOOL_NAMES) if (!allowed.has(name)) excluded.add(name);
  }
  for (const name of excluded) args.push('--exclude-tools', name);
  return args;
}

/**
 * Compare the tool list Qwen Code reported at startup with the node's restrictions.
 * Returns a description of the violation, or undefined when the reported set conforms.
 */
export function toolRestrictionViolation(
  restrictions: ToolRestrictions,
  reported: readonly string[]
): string | undefined {
  const active = reported.filter(name => name !== STRUCTURED_OUTPUT_TOOL);
  if (restrictions.allowed) {
    const allowed = new Set(restrictions.allowed);
    const extra = active.filter(name => !allowed.has(name));
    if (extra.length > 0) return `tools enabled outside allowed_tools: ${extra.join(', ')}`;
  }
  if (restrictions.denied) {
    const denied = new Set(restrictions.denied);
    const present = active.filter(name => denied.has(name));
    if (present.length > 0) return `denied_tools still enabled: ${present.join(', ')}`;
  }
  return undefined;
}
