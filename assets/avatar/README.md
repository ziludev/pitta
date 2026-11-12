# Agent avatar

A [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) definition: one silhouette plus
where the eyes sit, and that renderer gives it a soft volume. Ours is the **pie** — the π / pie pun:
a round crimped pie seen from above, two pill eyes on it.

| File | What it is |
| --- | --- |
| `pie.json` | The definition (v1, `validateAvatar` clean, 385 characters of path). Paste it into the [editor](https://dominikscholz.github.io/open-bot-avatar/) to recolor, turn, animate or export. |
| `pie-amber.svg` / `.png` | Amber. The default. |
| `pie-berry.svg` / `.png` | Berry. |
| `pie-teal.svg` / `.png` | Teal. |
| `pie-ink.svg` / `.png` | Ink body with mint eyes, for light surfaces that want weight. |
| `pie-idle.gif` | One state on a loop, 1.6 s, 26 frames at 16 fps, 256 px. |
| `pie-thinking.gif` | Same loop length, eyes shifted — use while a job runs. |
| `pie-happy.gif` | Same loop length, happy arcs — use when it finished. |
| `pie-states.gif` | All three in one loop (3 s, 48 frames), for a single place that has only one slot. |

The crimped rim is what makes it a pie rather than a cookie or a blob, and it is the one cue worth
keeping: the outline carries the recognition, since the renderer paints a single flat colour.

The PNGs are 512×512 with a transparent background, which is what the Feishu console wants for 头像
（开发者后台 → 应用信息 → 头像). Transparent on purpose: Feishu draws avatars on light and dark chrome
alike, and a filled square just becomes a second frame.

The GIFs render the renderer's three moods frame by frame with `time` and `motion`; the combined one
blends over the first 0.4 s of each switch. Frames share one palette so a loop does not shimmer. GIF transparency is a single bit,
so the frames are composited on white: an anti-aliased edge would fringe against any other colour.

`prompt.md` is the prompt this was designed with — the schema, the numeric limits and the craft rules,
self-contained, so another model can produce more candidates.

Tried and dropped: a stroke-drawn π on a dark square (a logo, not a character), the π as a solid slab
with a face on the brim (a crate), a pie with one slice lifted out (read as a cookie with a bite), and
a pie chart (read as an icon rather than this character).
