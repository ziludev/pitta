# Prompt for designing the avatar

Paste everything below into ChatGPT (or any model). It is self-contained: the rules are the ones the
[open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) engine actually validates, so the
JSON that comes back can be pasted straight into the editor and re-rendered here without repair.

---

## Task

Design the avatar for a chat bot. The bot is a server-side engineering assistant: it reads a product
requirement, writes a design, changes code, runs tests, ships to a test cluster and reports back in
chat. It lives in Feishu (a chat app), works for Chinese-speaking colleagues, and its name is 知衡
(zhī héng — 衡 means "to weigh").

The name is a pun: **π / pie**. Pick one of these three ideas, or something better along the same line:

1. **A pie** — a soft, chunky pie with a crimped crust, eyes on the body.
2. **A pie chart** — two or three separated wedges that together read as a round pie, eyes on the
   largest wedge.
3. **The letter π as an object** — the letter drawn as one soft silhouette (a wide brim on two legs),
   eyes on the brim. This one has already failed twice, so only attempt it if you can make it read as
   a character and not as a crate.

Give me **three candidates, one per idea**, so I can compare.

## What the renderer does with your JSON

It gives your silhouette a soft 3D volume by stacking cross-sections, lights it with one flat color,
and draws the eyes painted on the front surface. You control the silhouette and where the eyes sit —
nothing else. So the outline alone must carry the recognition at 28 px, and the part the face sits on
must be the largest mass.

The look: a simple, rounded character first and an object second — a soft, chunky blob of a few
rounded lobes, in one saturated flat color with two plain dark pill eyes.

## Output

Reply with exactly three lines, each one compact JSON on a single line, in the schema below. No prose,
no code fence, no colors, no extra keys.

```
{"version":1,"id":"slug","name":"Name","body":{"path":"M… Z"},"eyes":{"x":50,"y":46,"spacing":15,"scale":1}}
```

Format reference — a mug, from the engine's own examples (side view: a symmetric cup subpath turns as a
cylinder and carries the face; the handle is a separate outline with a counter-clockwise hole):

```
{"version":1,"id":"mug","name":"Mug","body":{"path":"M22 20H62C67 20 70 23 70 28V72C70 80 64 86 56 86H28C20 86 14 80 14 72V28C14 23 17 20 22 20ZM68 36C80 34 87 42 87 53C87 64 80 72 68 70ZM69 45L69 61C75.5 62 79 58.5 79 53C79 47.5 76 44 69 45Z"},"eyes":{"x":42,"y":49,"spacing":16,"scale":1.15}}
```

## Hard rules — a definition that breaks any of these is rejected outright

- Canvas is a fixed `0 0 100 100` viewBox, y pointing down. **Keep all geometry within 8..92.**
- `body.path` uses only `M L H V C S Q T A Z`. Numbers only; arc flags are separate `0`/`1` tokens. At
  most 16 subpaths, 400 segments, 6000 characters — aim well under 1500 characters.
- Fill rule is **nonzero**. Wind every outline clockwise on screen (travel left to right along the top
  edge). Overlapping clockwise subpaths merge into one shape. A hole is a subpath wound
  counter-clockwise inside an outline — use holes only for real see-through openings (a handle loop),
  never for decoration or for "the filling".
- The body must be at least 40 units on its long side and 14 on its short side, with 600 units² of fill.
- `eyes`: `x`,`y` is the center of the pair, `spacing` the center-to-center distance, `scale` 0.6..1.8.
  At scale 1 each eye is a 4 × 11 vertical pill; `spacing ≥ 7 × scale`. Default `scale` 1..1.15 and
  `spacing` 15..18 (up to 1.25 on a large round body).
- **Both eyes, plus a 1.2 unit margin, must lie on solid fill — never in a gap, notch or hole.** This
  is what broke my earlier attempts: eyes between the legs of a π, or inside a wedge cut out of a pie,
  are rejected.
- The engine draws the eyes up to 1.45× larger than the validated size, and the happy-mood arcs about
  2× as wide as a pill. So the face area wants roughly `(spacing + 12·scale + 9) × (16·scale + 9)`
  units of calm solid fill (about 36 × 25 at scale 1, spacing 15), with 4.5 units of clearance from the
  outline at rest and through the full gaze travel.
- `version` is `1`. `id` is a lowercase slug of 1–40 characters (`a-z`, `0-9`, inner `-`). `name` is
  the shortest title-case noun that still identifies the object (≤ 40 characters).

## Craft rules that decide whether it looks good

- **Face mass first.** The part carrying the face is the main mass: enlarge it beyond the object's real
  proportions as far as the face needs, and no further. Fix a cramped face by growing that part, never
  by shrinking `scale` below 1 or squeezing `spacing`.
- **Few parts, unified.** 1–7 soft primitives (rounded rects, capsules, blobs) overlapping into one
  silhouette. No buttons, slots, text or decorative cut-outs — anything invisible at 28 px is noise.
- **Toy proportions.** Chunky and slightly squat; every part at least 5 units thick; corner radii 3+
  units; no hairlines, no thin spikes; tapering parts end in a soft rounded tip, not a point. Prefer
  `C` curves and arcs to polygons for anything organic.
- **Clear joins.** Where two parts meet on the outline, either step decisively (3 units or more) or let
  one outline run on into the next at the same width and direction with the inner rounded corners
  buried inside. Edges that nearly line up leave a thin ledge or sliver, which reads as a flaw.
- **Balance.** Center the visual mass near x 50 and sit the object on a flat or gently rounded base near
  y 80–88 so it looks grounded. Eyes a little above the face area's center read friendlier.
- **Two eyes only.** No mouth, brows or pupils — the engine expresses mood itself.
- Keep silhouette transitions that make the object recognizable (a pie's crimped rim, a chart's gaps
  between wedges), but keep them few, rounded and chunky instead of collapsing everything into a blob.

Before you answer, check each definition against every rule above, especially: geometry inside 8..92;
eyes on solid fill with the 4.5-unit clearance at 1.45× size; face mass is the biggest part; no
decoration that disappears at thumbnail size.
