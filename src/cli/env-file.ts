/**
 * `.env` is a file people edit by hand, so setup must not reformat it: comments, ordering
 * and keys this version does not know about all survive a merge. Only the values setup
 * asked about are replaced, and only the ones missing are appended.
 */
export function renderEnv(existing: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = existing.length === 0 ? [] : existing.replace(/\n$/, "").split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) {
      out.push(line);
      continue;
    }
    out.push(`${key}=${pending.get(key) ?? ""}`);
    pending.delete(key);
  }

  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}
