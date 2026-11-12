# Agent avatar

A [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) definition: one silhouette plus
where the eyes sit, and that renderer gives it a soft volume. Ours is a **pie chart** — the π / pie
pun, and a quiet nod to the work (measure, split, report), with the eyes on the biggest wedge.

| File | What it is |
| --- | --- |
| `pie-chart.json` | The definition (v1, `validateAvatar` clean). Paste it into the [editor](https://dominikscholz.github.io/open-bot-avatar/) to recolor, turn, animate or export. |
| `pie-chart-amber.svg` / `.png` | Amber. The default. |
| `pie-chart-berry.svg` / `.png` | Berry. |
| `pie-chart-teal.svg` / `.png` | Teal. |
| `pie-chart-ink.svg` / `.png` | Ink body with mint eyes, for light surfaces that want weight. |
| `pie-chart-idle.gif` | 3 s loop, 48 frames at 16 fps, 256 px: idle → thinking → happy. |

The three wedges are drawn programmatically rather than by hand: equal 12° gaps (about 9 units at the
rim), a round centre hole, and the eyes on the bottom wedge. The gaps are equal *and* wide enough that
the wedges read as separate pieces — narrowing them to thin cuts turns the chart back into a pie with
knife marks, which is what the first attempt looked like.

The PNGs are 512×512 with a transparent background, which is what the Feishu console wants for 头像
（开发者后台 → 应用信息 → 头像). Transparent on purpose: Feishu draws avatars on light and dark chrome
alike, and a filled square just becomes a second frame.

The GIF has a white background, because GIF transparency is one bit and the anti-aliased rim would
fringe against any other colour. It animates the renderer's three moods: pills at rest, eyes shifting
while thinking, then the happy arcs. Regenerate with `time`/`motion` per frame — the engine does the
rest, no hand-drawn keyframes.

`prompt.md` is the prompt this was designed with — the schema, the numeric limits and the craft rules,
self-contained, so another model can produce more candidates.

Not kept: a stroke-drawn π on a dark square (a logo, not a character), the π as a solid slab with a
face on the brim (a crate), a pie with a slice lifted out (read as a cookie with a bite), and a
24-lobe crimped pie (read as a blob).
