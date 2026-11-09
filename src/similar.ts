/**
 * Cheap near-duplicate check for memory notes: character bigrams + Dice
 * coefficient. Good enough to catch "Alex 喜欢喝美式咖啡" vs "主人喜欢喝美式咖啡",
 * which plain substring matching misses.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s.,:;!?，。：；！？、（）()【】[\]"'`]/g, "");
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** 0 = unrelated, 1 = identical (after normalisation). */
export function similarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const first = bigrams(left);
  const second = bigrams(right);
  let overlap = 0;
  for (const [gram, count] of first) {
    const other = second.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  const total = left.length - 1 + (right.length - 1);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function isDuplicate(text: string, existing: readonly string[], threshold = 0.62): boolean {
  return existing.some((note) => similarity(note, text) >= threshold);
}
