/**
 * Fallback parse of a final reply as a JSON object, for a turn where the model answered
 * in text instead of calling Qwen Code's `structured_output` tool. Archon validates the
 * value against the node's schema and re-asks on a miss (best-effort tier).
 */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseStructuredText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
  const direct = parseObject(unfenced);
  if (direct) return direct;
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  return first >= 0 && last > first ? parseObject(unfenced.slice(first, last + 1)) : undefined;
}
