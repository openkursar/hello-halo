# Deck design systems

Read this before writing any slide code. **Pick ONE system below and execute it on every slide** — consistency is what makes a deck look designed instead of generated. When the user states no styling preference, choosing a system from this file is mandatory; a bare-default pptxgenjs look is not an acceptable output.

All coordinates assume `LAYOUT_WIDE` (13.33 × 7.5 in). Colors are 6-hex without `#`.

## Choosing a system

| System | Use when the topic is… |
|---|---|
| 1 深空商务 Deep Space | executive review, strategy, finance, board material |
| 2 浅色极简 Light Minimal | product, engineering, design, research briefs |
| 3 活力提案 Vivid Pitch | marketing, sales proposals, launches, creative work |
| 4 高端质感 Premium | brand, luxury, annual report, investor-facing polish |
| 5 科技蓝 Tech Blue | technical roadmaps, data/infra topics, B2B SaaS |

If nothing matches, default to 2 (浅色极简) for content-heavy decks and 1 (深空商务) for persuasion decks.

## The five systems

Each spec: palette → typography → title slide recipe → content skeleton → shape language. Execute the whole column, not a mix.

### 1 · 深空商务 Deep Space

- **Palette**: bg `0E1A2B` · panel `16283F` · ink `F2F5F8` · muted `8DA2B5` · accent `E8A33D` (amber) · accent2 `3FA7D6` (sky)
- **Type**: Arial. Slide titles 32pt bold ink; body 15pt ink; labels 12pt muted; hero numerals 44–60pt bold accent.
- **Title slide**: full `0E1A2B` bg (via a slide master `background`). Title 44pt bold at x0.9 y2.5 w11.5; a 2.4×0.07 accent bar directly ABOVE the subtitle line; subtitle 20pt muted. Lower-right: 12pt muted date/author. Nothing else.
- **Content skeleton**: title at x0.6 y0.35, then a 1.6×0.06 accent bar at y1.15 (this bar is the system's structural signature — same size and position on every content slide). Content zone y1.5–7.0. Cards = `roundRect` panels (`16283F`, rectRadius 0.08).
- **Shape language**: rounded (radius 0.08 everywhere), filled panels not outlines, no border lines on shapes. Charts: bars in accent, axis labels muted.

### 2 · 浅色极简 Light Minimal

- **Palette**: bg `FFFFFF` · surface `F4F5F7` · ink `16181D` · muted `7A828E` · accent `2447F0` (cobalt) — ONE accent only.
- **Type**: Arial. Slide titles 30pt bold ink; body 15pt ink; hero numerals 60–80pt bold in ink (not accent — restraint is the style); only 1–2 accent-colored elements per slide.
- **Title slide**: white. Enormous title, 54pt bold ink, upper-left at x0.9 y1.6 w10; a single 0.9×0.09 accent bar at x0.9 y1.25 (above the title); subtitle 18pt muted under the title. Bottom-left 12pt muted meta. ≥60% of the slide stays empty — that emptiness is the design.
- **Content skeleton**: title x0.9 y0.5, no bar, no underline. Content starts y1.7, left margin 0.9 (wider than other systems). Blocks separated by whitespace ≥0.45, never by boxes; use `F4F5F7` surface fills only for tables/code-like content. Hairline dividers (`line`, 0.75pt, `E3E5E9`) only when two unrelated zones share a slide.
- **Shape language**: sharp corners (plain `rect`), hairlines, no shadows, no rounded anything. Numbered lists over bullet dots where possible ("01  02  03" in accent, 13pt bold).

### 3 · 活力提案 Vivid Pitch

- **Palette**: bg `FFFFFF` · ink `191921` · accent `FF5A4E` (coral) · accent2 `6C3FF5` (violet) · tint `FFF0EE` (8% coral)
- **Type**: Arial. Titles 34pt bold; hero numerals 72–96pt bold accent used AS GRAPHICS (see techniques); body 15pt.
- **Title slide**: half-slide color panel — full-height `FF5A4E` rect covering x0–5.2; deck title 40pt bold WHITE inside the panel (x0.6 y2.6 w4.2, two lines welcome); subtitle + meta in ink on the white half (x5.8 y3.0). The hard color edge is the composition.
- **Content skeleton**: alternate two skeletons across the deck — (a) white slide, title x0.6 y0.4, oversized section number 96pt in `FFF0EE` tint placed behind-left at x0.35 y0.1 (draw it FIRST so the title overlaps it); (b) 1/3 color panel slide: `6C3FF5` or `FF5A4E` rect x0–4.4 full height carrying the takeaway in white 24pt bold, evidence on the white 2/3.
- **Shape language**: sharp rectangles, bold color blocks, no outlines, no rounded corners. Emphasis by color inversion (white-on-accent chips), never by underline.

### 4 · 高端质感 Premium

- **Palette**: bg `FAF7F2` (warm off-white) · ink `1C2B26` (deep green-black) · muted `8A8478` · accent `9C7A3C` (muted gold) · panel `EFEAE1`
- **Type**: Georgia (serif — the texture of this system). Titles 32pt bold ink; body 14pt ink, `lineSpacingMultiple: 1.25`; hero numerals 48pt Georgia bold accent; labels 11pt muted with wide tracking feel (add spaces between characters of short all-caps labels: "O V E R V I E W").
- **Title slide**: `FAF7F2` bg. Centered composition: 11pt gold spaced-caps kicker at y2.3, title 46pt Georgia bold ink centered y2.8 w9 (x2.17), 0.5×0.02 gold hairline centered below, subtitle 15pt muted centered. Corner meta 11pt muted at x0.9 y6.9.
- **Content skeleton**: title x0.9 y0.5 with a 0.35×0.02 gold hairline at y1.25 (hairline, not bar — weight is what separates premium from corporate). Content y1.6+, generous 0.9 margins. Data in `EFEAE1` panels with 1pt `D8D0C0` border.
- **Shape language**: hairlines (0.75–1pt), thin-bordered panels, ellipse markers, nothing thicker than 2pt, no saturated colors anywhere.

### 5 · 科技蓝 Tech Blue

- **Palette**: bg `FFFFFF` · rail `0B1526` · ink `101828` · muted `667085` · accent `1570EF` (electric blue) · tint `EFF4FF`
- **Type**: Arial. Titles 30pt bold; body 14pt; mono-feel labels via Courier New 12pt for versions/metrics/API names.
- **Title slide**: left rail — full-height `0B1526` rect x0–3.6; inside it: product/deck name 30pt bold white rotated composition NOT required — simply stack name 32pt white + version tag Courier 13pt `1570EF` at x0.5 y2.8. Right side white: title 40pt bold ink x4.2 y2.6 w8.5, subtitle muted below.
- **Content skeleton**: slim structural rail — `0B1526` rect x0 y0 w0.28 full height on EVERY content slide (this narrow rail is structure: it carries the section color; change rail color per section for wayfinding). Title x0.7 y0.4; content y1.5+. Process/architecture slides: `EFF4FF` tint boxes with 1pt `1570EF` border, connected by 1.5pt accent lines.
- **Shape language**: 0.04 corner radius (barely rounded), thin borders + tint fills, arrows/connectors encouraged, chips (small `roundRect` + Courier text) for statuses.

## Techniques that read as "designed"

Verified to render; use them per your system's shape language.

- **Oversized numerals as graphics**: draw a 90–140pt numeral in a light tint FIRST, then overlap real content on top of it. `s.addText('01', { fontFace:'Arial', fontSize:120, bold:true, color:'FFF0EE', x:0.2, y:0.4, w:3, h:2 })` then title at y0.9. Works because later draws stack above earlier ones.
- **Half- and third-slide color panels**: full-bleed `rect` from edge to edge (x0 or y0, through 13.33/7.5) carrying inverted text. Put the takeaway on the color, the evidence on the white.
- **Layered tints instead of images**: 2–3 large rects of the same hue at decreasing strength (e.g. `EFF4FF`, `DBE7FE`, accent) offset diagonally behind a title or stat — image-free visual richness. Draw dark-to-light first, content last.
- **Whitespace discipline**: decide the deck's gap unit (0.3 or 0.45) once; every gap is 1× or 2× that unit. When a slide feels empty, enlarge the type or the margins — do not add decoration.
- **Micro-consistency**: one corner radius, one line weight, one gap unit, one accent usage rule for the whole deck. Same title x/y on every content slide — titles must not jump between slides.
- **Structure vs filler**: decoration is STRUCTURE when it encodes something (rail color = section; accent bar = fixed title anchor; color panel = the takeaway). It is FILLER when removing it changes nothing (random stripes, corner blobs, per-slide different underlines). Every decorative element must pass the "what does it encode?" test.

## Chinese / CJK decks

- **Fonts**: `fontFace: '微软雅黑'` (Microsoft YaHei) for both titles and body — renders correctly in Office and WPS on Chinese Windows; macOS falls back sanely. Alternative pairing: 思源黑体 if the user's org uses it. Never SimSun/宋体 for slide body (hairline strokes disappear on projectors); never fake-bold 宋体.
- **Line height**: CJK glyphs fill the em square — add `lineSpacingMultiple: 1.25` (up to 1.35 for 12–13pt) on multi-line CJK text or lines visually collide.
- **Sizes**: CJK reads denser than Latin — drop one step: titles 30–36pt, body 14–16pt. Keep hero numerals Latin (Arial) even in CJK decks; mixed 中文 label under an Arial numeral is the standard treatment.
- **Punctuation**: full-width （）、。 need no extra tracking; avoid leading punctuation at line starts by keeping lines short (w generous, text concise).

## Structure rules (all systems)

1. Title slide per the system recipe; closing slide = the ask / next steps, never bare "Thank you".
2. One idea per slide; the title states the takeaway ("毛利率回升至 41%"), not the topic ("毛利率").
3. Agenda for decks > 8 slides; section dividers (reuse the title-slide composition, smaller) for sections > 3 slides.
4. Max ~5 bullets, one line each; split dense slides rather than shrink below 14pt.
5. Vary content skeletons — two consecutive slides must not share the same layout; rotate stat callouts / comparison columns / timeline / chart / panel takeaway.
6. Sources and caveats: 10–11pt muted at y ≥ 7.0.
