# Agent avatar

A [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) definition: one silhouette plus
where the eyes sit, and that renderer gives it a soft volume. Ours is the **π / pie pun** — a pie with
one slice lifted out, the crimped crust all the way round the edge.

| File | What it is |
| --- | --- |
| `pie.json` | The definition (v1). Paste it into the [editor](https://dominikscholz.github.io/open-bot-avatar/) to recolor, turn, animate or export. |
| `pie-gold.svg` / `.png` | Golden crust — the plain pie. |
| `pie-berry.svg` / `.png` | Berry filling. |

512×512 PNGs with a transparent background, which is what the Feishu console wants (开发者后台 →
应用信息 → 头像). Transparent on purpose: Feishu draws avatars on light and dark chrome alike, and a
filled square just becomes a second frame.

The eyes sit on the remaining body, not in the gap — this spec requires them inside the silhouette with
clearance (`eyes must sit inside the body`).

Not kept: two earlier drafts of the letter π drawn as a figure (a stroke glyph on a dark square, then a
slab with a face). Both read as a logo or a crate rather than a character.
