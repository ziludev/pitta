# Agent avatar

A [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) definition: one silhouette plus
where the eyes sit, which that renderer turns into a soft volume. Ours is the π as a little figure —
a wide brim for a face, two legs under it. π is also a balance beam on two posts, which is what 知衡
says: 衡, to weigh.

| File | What it is |
| --- | --- |
| `pi-bot.json` | The definition (v1, `validateAvatar` clean). Paste it into the [editor](https://dominikscholz.github.io/open-bot-avatar/) to recolor, turn, animate, or export at any size. |
| `pi-bot-mint.svg` / `.png` | Mint on nothing — the default. |
| `pi-bot-blue.svg` / `.png` | Blue, for when the mint reads too soft. |
| `pi-bot-ink.svg` / `.png` | Ink body with mint eyes, for light surfaces that need weight. |

The PNGs are 512×512 with a transparent background, which is what the Feishu console wants for 头像
（开发者后台 → 应用信息 → 头像). The background stays transparent on purpose: Feishu draws the avatar
on both light and dark chrome, and a filled square would just become a second, wrong frame.

The eyes are meant to survive small sizes: at 32px they read as a hint, and the π is still the mark.

Rendered with the upstream renderer (`renderAvatarSvg`, depth 5, size 512), so the files are what the
editor would produce for the same definition.
