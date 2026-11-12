# Agent avatar

A [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) definition: one silhouette plus
where the eyes sit, and that renderer gives it a soft volume. Ours is a **pie chart** — the π / pie
pun, and a quiet nod to the work (measure, split, report), with the eyes on the biggest wedge.

| File | What it is |
| --- | --- |
| `pie-chart.json` | The definition (v1, `validateAvatar` clean, 262 characters of path). Paste it into the [editor](https://dominikscholz.github.io/open-bot-avatar/) to recolor, turn, animate or export. |
| `pie-chart-amber.svg` / `.png` | Amber. The default. |
| `pie-chart-berry.svg` / `.png` | Berry. |
| `pie-chart-teal.svg` / `.png` | Teal. |
| `pie-chart-ink.svg` / `.png` | Ink body with mint eyes, for light surfaces that want weight. |

512×512 PNGs with a transparent background, which is what the Feishu console wants (开发者后台 →
应用信息 → 头像). Transparent on purpose: Feishu draws avatars on light and dark chrome alike, and a
filled square just becomes a second frame.

`prompt.md` is the prompt this was designed with — the schema, the numeric limits and the craft rules,
self-contained, so another model can produce more candidates.

Not kept: a stroke-drawn π on a dark square (a logo, not a character), the π as a solid slab with a
face on the brim (a crate), and a pie with a slice lifted out (read as a cookie with a bite).
