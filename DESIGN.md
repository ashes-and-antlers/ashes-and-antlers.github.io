---
name: Ashes and Antlers
description: A night-bound, ledger-calm instrument HUD for a deterministic two-civilization simulation.
colors:
  deep-forest: '#162218'
  forest-panel: '#1d2a20'
  panel-surface: 'rgba(29, 42, 32, 0.9)'
  panel-border: 'rgba(211, 199, 172, 0.14)'
  bone: '#d3c7ac'
  worn-stone: '#9c8e76'
  ember: '#c97844'
  ember-soft: 'rgba(201, 120, 68, 0.16)'
  ember-deep: '#b3673e'
  ember-on: '#162218'
  ember-border: 'rgba(201, 120, 68, 0.45)'
  ember-border-soft: 'rgba(201, 120, 68, 0.35)'
  hover-fill: 'rgba(211, 199, 172, 0.1)'
  hover-fill-strong: 'rgba(211, 199, 172, 0.2)'
  shadow-deep: 'rgba(0, 0, 0, 0.4)'
  shadow-mid: 'rgba(0, 0, 0, 0.35)'
  scorch-red: '#e0605a'
  hearth-amber: '#e8a13b'
  iron-tide: '#4fc3c9'
  deep-water: '#17243a'
  water: '#2a4d8f'
  marsh: '#4e5f35'
  grass: '#5d8a3c'
  forest: '#2e5a2c'
  hill: '#8a7a52'
  mountain: '#9ca2aa'
typography:
  display:
    fontFamily: "'Cinzel', 'Inter', Georgia, 'Times New Roman', serif"
    fontSize: 'clamp(2.7rem, 8.2vw, 5.4rem)'
    fontWeight: 700
    letterSpacing: '0.055em'
  headline:
    fontFamily: "'Cinzel', 'Inter', Georgia, 'Times New Roman', serif"
    fontSize: 'clamp(21px, 2.9vw, 27px)'
    fontWeight: 600
    letterSpacing: '0.06em'
  tagline:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 'clamp(17px, 2vw, 20px)'
    fontWeight: 550
  title:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '16px'
    fontWeight: 650
  lead:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '15.5px'
    fontWeight: 400
  brand:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '15px'
    fontWeight: 650
  body:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '12px'
    fontWeight: 400
  micro:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '10px'
    fontWeight: 700
  footer:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    fontSize: '11px'
    fontWeight: 400
  label:
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '9px'
    fontWeight: 700
    letterSpacing: '0.12em'
  data:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    fontSize: '13px'
    fontWeight: 600
    lineHeight: 1.3
rounded:
  xs: '6px'
  sm: '8px'
  md: '10px'
  pill: '999px'
spacing:
  xs: '8px'
  sm: '10px'
  md: '14px'
  lg: '18px'
components:
  button-speed:
    backgroundColor: 'rgba(211, 199, 172, 0.05)'
    textColor: '{colors.bone}'
    rounded: '{rounded.sm}'
    padding: '7px 10px'
  button-speed-active:
    backgroundColor: '{colors.ember}'
    textColor: '{colors.ember-on}'
    rounded: '{rounded.sm}'
    padding: '7px 10px'
  toggle:
    backgroundColor: 'rgba(211, 199, 172, 0.05)'
    textColor: '{colors.worn-stone}'
    rounded: '{rounded.sm}'
    padding: '8px 14px'
  toggle-active:
    backgroundColor: '{colors.ember-soft}'
    textColor: '{colors.ember}'
    rounded: '{rounded.sm}'
    padding: '8px 14px'
  chip:
    backgroundColor: '{colors.panel-surface}'
    textColor: '{colors.worn-stone}'
    rounded: '{rounded.pill}'
    padding: '8px 12px'
  panel:
    backgroundColor: '{colors.panel-surface}'
    textColor: '{colors.bone}'
    rounded: '{rounded.md}'
    padding: '10px 16px'
---

# Design System: Ashes and Antlers

## Overview

**Creative North Star: "The Ember Archive"**

The interface is a chronicler's ledger for a burning world. Deep-forest surfaces hold ember entries; every number is a witness, every panel a page of the chronicle. The living map below — green pasture, forest, slate water, amber and teal territories — is the world that burns and rebuilds; the HUD is the archive that records its causes and effects without ever shouting over it.

The archive is night-bound and ledger-calm: a deep-forest field, body text in bone, secondary text in worn stone, and a single warm ember used with the discipline of a seal. The palette is derived from the brand mark (`public/logo.png`): its deep forest, bone, and burnt-orange accents define the field, the text, and the seal. Surfaces are being flattened (confirmed direction): panels go solid and opaque, retiring the incumbent translucent glass and backdrop blur; depth comes from tonal separation against the map rather than translucency. Components are refined and restrained — quiet, precise, instrumental — with small uppercase letterspaced labels, monospaced figures, hairline borders, and minimal motion.

**Key Characteristics:**

- Night-bound: deep-forest field, bone text, ember seal
- Ledger-calm: uppercase micro-labels and tabular mono figures on every data surface
- Restrained instrumentality: hairline borders, small radii, no decoration
- The map leads: instruments sit at the edges and recede in hierarchy
- Confirmed anti-references: no colorful cartoon, no sterile SaaS dashboard, no military-green tactical console

## Colors

The palette is a deep-forest neutral field, one ember seal, two faction hues, and the natural terrain gamut of the living map — all derived from the brand mark (`public/logo.png`).

### Primary

- **Ember** (#c97844): the only saturated accent on instrument surfaces — a legible step up from the logo's burnt orange. Active speed button, brand milestone tag, terrain-hash readout, citizen carry dots, focus ring, the landing CTA. Rarity is its power — see The Ember Seal Rule.
- **Ember Deep** (#b3673e): the logo's own burnt orange; large fills and display-scale accents where the deeper tone carries.

### Faction (semantic, never decorative)

- **Hearth Amber** (#e8a13b): the Hearth Confederacy — ownership overlay, command centers, citizens.
- **Iron Tide** (#4fc3c9): the Iron Swarm — ownership overlay, command centers, citizens.

### Neutral

- **Deep Forest** (#162218): canvas and app background; also the PixiJS clear color — the logo's dominant green.
- **Forest Panel** (#1d2a20): solid plate surfaces on the landing page.
- **Panel Surface** (rgba(29, 42, 32, 0.9)): floating instruments. Flattening direction: render new surfaces solid and opaque.
- **Bone** (#d3c7ac): body and title text — the logo's cream.
- **Worn Stone** (#9c8e76): muted text, group labels, the neutral-faction fallback.
- **Panel Border** (rgba(211, 199, 172, 0.14)): the universal hairline, bone-tinted.
- **Scorch Red** (#e0605a): danger only — fatal boot errors and severity-2 alerts.
- **Ember On** (#162218): the text and glyph color placed on Ember (active speed button, primary CTA). Deep forest so the ember seal stays legible.
- **Supporting tones:** Ember Border (rgba(201, 120, 68, 0.45)) and Ember Border Soft (rgba(201, 120, 68, 0.35)) for active-state borders; Hover Fill (rgba(211, 199, 172, 0.1)) and Hover Fill Strong (rgba(211, 199, 172, 0.2)) for bone-tinted hover surfaces; Shadow Deep (rgba(0, 0, 0, 0.4)) and Shadow Mid (rgba(0, 0, 0, 0.35)) for the ambient panel shadows.

### The Living Map (terrain)

- **Deep Water** (#17243a), **Water** (#2a4d8f), **Marsh** (#4e5f35), **Grass** (#5d8a3c), **Forest** (#2e5a2c), **Hill** (#8a7a52), **Mountain** (#9ca2aa). The renderer shades each by elevation (×0.78–1.10) — the map's only dynamic color variation. The terrain palette is sim data (`src/sim/world/tiles.ts`); change it only through content, never by ad-hoc renderer tweaks.

### Named Rules

**The Ember Seal Rule.** Ember covers ≤10% of any surface. It appears where the player acts or where truth is stamped: the active speed, the hash, the carry. When ember appears twice, the screen is wrong.
**The Two-People Rule.** Hearth Amber and Iron Tide appear only where faction meaning is at stake — ownership, control, allegiance. Never as decoration.
**The Brand Mark Rule.** The logo is the title. Where the brand mark appears, never re-type the name beside or above it — the mark carries the wordmark. On the landing page the cover is the mark itself, dead-center on the field with no frame, no tag, and no nav; the footer carries status lines only.

## Typography

**Body Font:** 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif. Note: no webfont is actually loaded — system-ui is the de-facto face.
**Label Font:** the same sans stack, uppercase, letterspaced.
**Data Font:** ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace.

**Character:** A quiet sans with an uppercase, letterspaced micro-label voice and monospaced figures for every number — an instrument panel, not an editorial layout. The system's one display voice is **Cinzel** (self-hosted via `@fontsource/cinzel`, inlined into the landing CSS as base64 data URIs so no font file requests reach the hosting pipeline): carved-inscription caps used for the landing entry headings. The HUD stays sans — the archive engraves its pages, not its instruments. The cover needs no display type at all: the brand mark itself is the cover.

### Hierarchy

- **Display** (Cinzel 700, clamp(2.7rem, 8.2vw, 5.4rem), uppercase, 0.055em): **retired from the cover** — the brand mark (public/logo.png) carries the wordmark and is displayed at clamp(300px, 38vw, 520px), dead-center in a full-viewport hero, unframed and untagged, with the primary Enter action beneath it and the scroll cue anchored to the hero's bottom edge. Cinzel 700 stays available for future display moments.
- **Headline** (Cinzel 600, clamp(21px, 2.9vw, 27px), uppercase, 0.06em): landing entry headings.
- **Tagline** (550, clamp(17px, 2vw, 20px)): the landing cover's one-line hook.
- **Title** (650, 16px; 13–14px on the HUD): card titles, brand title, inspector heading.
- **Lead** (400, 15.5px): the landing cover lede.
- **Body** (400, 12–14px): alert text, inspector rows, landing paragraphs.
- **Label** (700, 9–10px, 0.12–0.14em, uppercase): readout labels, speed-group label, brand tag, alert codes.
- **Caption** (400, 12px): plate captions, determinism notes, seed labels.
- **Micro** (700, 10px, uppercase): scroll cue, tiny section labels.
- **Footer** (400, 11px, mono): the landing footer.
- **Data** (600, 13–14px, mono, tabular): tick/day/season/year readouts, terrain hash (accent-colored), seed/status chips, speed buttons.

### Named Rules

**The Ledger Rule.** Every figure is monospaced with tabular numerals; a number never wraps, breaks, or loses alignment with its column label.
**The Label Voice Rule.** Micro-labels are always uppercase and letterspaced; sentence case is reserved for descriptive body text only.

## Layout

The shell is a map-first canvas with floating instruments pinned to the edges on a 14px screen inset:

- **Top bar:** brand (left) with milestone tag; seed + worker-status chips (right).
- **Bottom bar:** centered instrument strip — speed group, readout cluster (tick/day/season/year/hash), stock readouts (wood/stone/planks/food for the selected build faction), build palette, overlay toggles — capped at `min(100vw - 28px)`.
- **Alerts:** stacked banner, centered below the top bar (top 64px).
- **Inspector:** fixed bottom-left above the bottom bar (bottom 84px), 250px wide.

The map occupies the full viewport and is always the deepest, largest element. Spacing rhythm: 8px component gaps, 10px panel padding, 14px screen inset, 18px bottom-bar cluster gap.

## Elevation & Depth

The night field carries the atmosphere. Behind every surface: a deep forest vignette (edges darken), a ruled hairline frame around the viewport, and the burning field — a warm fire glow rising from the bottom edge with a few sparks climbing from it, while soft grey ash drifts back down through the night, generated by the landing script (hidden under `prefers-reduced-motion`).

Direction (confirmed): **flatten**. The incumbent panels are translucent glass (rgba surface, backdrop blur 10–12px, shadows 0 6–8px 24–28px at 0.35–0.4 alpha); new and revised surfaces should be **solid and opaque**, with no translucency or blur. Depth is conveyed by tonal layering — ink canvas, panel surface, hairline border — plus a soft ambient shadow only where an instrument overlaps the map.### Named Rules
**The Flat Ledger Rule.** Surfaces are solid. No backdrop-filter, no translucent fills; separation comes from tone and the hairline, never from blur.
**The Ember Field Rule.** Atmosphere is background paint, never surface. The vignette, the ruled frame, the bottom fire glow, and the drifting ash sit behind the content, stay still under reduced motion, and never compete with the map or the instruments.

## Shapes

Small radii and hairline strokes throughout: 10px panels, 8px buttons and alerts, full pills for chips and tags. Borders are 1px at panel-border strength. On the map: command centers are 3-tile squares (faction fill at 25%, 2.5px stroke, inner hairline); work buildings (sawpit) and stockpiles/huts are distinct 3-tile building marks in faction fill with a stroke; citizens are ~3.2px-radius dots with state rings (movement ring, white eating ring, work dot); nodes are minimal glyphs — berry clusters (three red dots), stone diamonds (polygon), tree circles (green fill, darker stroke).

## Components### Speed Buttons

- **Shape:** 8px radius, min-width 44px, mono 13px.
- **Default:** bone 6% fill, hairline border, bone text.
- **Active:** Ember fill, deep-forest text (#162218), 3px ember-soft halo (`0 0 0 3px` rgba(201, 120, 68, 0.16)).
- **Hover / Focus:** fill lifts to bone 10%; focus ring is 2px Ember.### Toggles
- **Shape:** 8px radius, uppercase 12px 600, hairline border.
- **Active:** ember text + ember-soft fill + ember-tinted border (rgba(201, 120, 68, 0.45)).### Chips
- **Style:** full pill, panel surface, mono 12px, worn-stone text; the status chip carries an 8px pulsing dot (2s ease) that stays muted until the worker is ready.

### Panels (brand, bottom bar, inspector)

- **Corner Style:** 10px radius.
- **Background / Border:** panel surface, 1px panel-border.
- **Shadow Strategy:** soft ambient shadow only where overlapping the map; no blur (see The Flat Ledger Rule).
- **Internal Padding:** 8–16px scale (brand 8×14, inspector 12×14, bottom bar 10×16).### Alerts
- **Style:** 8px radius, panel surface, hairline border; code in mono uppercase (muted → ember at severity 1 → scorch red at severity 2).
- **Severity 2** additionally takes a scorch-red border (rgba(224, 90, 90, 0.5)); entry animation is a 220ms fade-slide, disabled under reduced motion.

### Inspector

- **Style:** title at 650, then label/value rows — muted left label, right-aligned mono value — 2px row rhythm, 12px type.

## Do's and Don'ts### Do:

- **Do** keep Ember rare — active state, the hash, the carry; one ember moment per surface.
- **Do** set every figure in mono with tabular numerals under its uppercase micro-label.
- **Do** use Hearth Amber and Iron Tide only for faction meaning.
- **Do** flatten surfaces: solid opaque panels, tone + hairline for separation.
- **Do** preserve the map's readability — instruments at the edges, map centered and unobstructed.
- **Do** keep the brand mark (public/logo.png) on the forest field — it is the palette's source and the title, never recolored and never re-typed (see The Brand Mark Rule).### Don't:
- **Don't** drift into a colorful cartoon strategy palette — no saturated multicolor UI.
- **Don't** drift into a sterile SaaS dashboard — no blue links, dense tables, or empty-state illustrations.
- **Don't** drift into a military-green tactical console — no olive/khaki, no angular HUD clutter.
- **Don't** add translucency or backdrop blur; the glass look is being retired.
- **Don't** add a second display face — Cinzel is the system's single engraved voice, and the HUD stays sans.
- **Don't** re-type the title where the brand mark carries it — no text wordmark beside the logo, and no cover title above it.
- **Don't** add saturation beyond the three accents (ember, amber, teal) and the terrain gamut.
- **Don't** recolor, tint, or distort the brand mark — it is the palette's source of truth.
