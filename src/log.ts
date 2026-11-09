/** Timestamped logging: launchd captures stdout/stderr into files, so every line needs its own time. */
export function log(scope: string, ...parts: unknown[]): void {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  console.log(`[${stamp}] [${scope}]`, ...parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))));
}

export function logError(scope: string, ...parts: unknown[]): void {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  const detail = parts.map((part) => {
    if (part instanceof Error) return `${part.message} ${part.stack?.split("\n").slice(1, 3).join(" | ") ?? ""}`;
    return typeof part === "string" ? part : JSON.stringify(part);
  });
  console.log(`[${stamp}] [${scope}] ERROR`, ...detail);
}
