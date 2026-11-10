/**
 * Motion Prompt numbers, ported as-is (ui pack, MIT, (c) 2026 Shohei Ohtaki).
 * Easing names match the specs so a later edit can be checked against them.
 */
/** Tuples for Motion, strings for CSS. Same curves the specs name. */
export const easeInOutCubic: [number, number, number, number] = [0.65, 0, 0.35, 1]; // #052 #056 #057 #081
export const easeOutCubic: [number, number, number, number] = [0.33, 1, 0.68, 1]; // #055 #070 #072
export const cssEase = (curve: readonly number[]): string => `cubic-bezier(${curve.join(", ")})`;

/** #052 accordion: open 0→1 over 350 ms. */
export const accordion = { duration: 0.35, ease: easeInOutCubic };
/** #055 popover: 280 ms, 6 px slide from the anchor side. */
export const popover = { duration: 0.28, ease: easeOutCubic, shift: 6 };
/** #057 tabs: underline moves over 250 ms; content swaps 200 ms with a 100 ms hand-over. */
export const tabs = { underline: 0.25, content: 0.2, handover: 0.1, rise: 8 };
/** #070 spinner: blue 243° arc turning 1.3 times per second. */
export const spinner = { revSeconds: 1 / 1.3, arcDegrees: 243, thickness: 6, radius: 26 };
/** #072 empty state: fade in while rising 8 px over 350 ms. */
export const emptyState = { duration: 0.35, rise: 8 };
/** #081 hover lift: 10 px over 300 ms, shadow blur 6→22, y 2→12, alpha .08→.22. */
export const hoverLift = { duration: 0.3, rise: 10, blurFrom: 6, blurTo: 22, yFrom: 2, yTo: 12 };
