/**
 * The panel's visual vocabulary.
 *
 * Styled entirely with the console's CSS custom properties rather than an
 * imported token object. They are the real contract: the light and dark palettes
 * swap underneath without this component re-rendering, and a plugin that hard-
 * coded a hex would be the one thing on the page that did not follow the theme.
 * `CSS_VARIABLES` in the SDK is the list of names guaranteed to be defined in
 * both modes — nothing here reaches for one outside it.
 *
 * Which means the palette and the typefaces are not this panel's to choose, and
 * what is left to design with is **structure**: spacing, rhythm, weight,
 * letterspacing, and the shape of the one element the panel is remembered by.
 * That is a real constraint rather than a limitation — the console's own rule is
 * that colour means provider identity or state and nothing else, so a rarity
 * drawn as a hue would be a decorative colour on a surface that has none, and it
 * would say "legendary" only to somebody who already knew the key.
 *
 * So rarity is set in letterspaced small caps and shininess is a glyph beside a
 * word. Both are legible in either theme, to a screen reader, and to somebody
 * who has never seen the panel before.
 */

import styled from "styled-components";

/** A 4px rhythm, so nothing in the panel is spaced by eye. */
export const SPACE = { xs: "4px", sm: "8px", md: "12px", lg: "20px", xl: "32px" } as const;

/**
 * How big a companion is drawn — and why this number and not a rounder one.
 *
 * The animated Gen-V set the plugin fetches is a 96px canvas, and it is pixel
 * art rendered with `image-rendering: pixelated`, so the scale factor has to be
 * a whole number. At 128px — the obvious "a bit larger" — 96 goes into it 1.333
 * times, and nearest-neighbour turns that into alternating one- and two-pixel
 * source pixels: the sprite is bigger and visibly lumpier, in a way that reads
 * as a broken image rather than as a design decision. 192px is 2× exactly.
 *
 * The sprite, the egg and the unreadable mark all take it, because they occupy
 * the same slot on the same two surfaces: a roster whose cards were one size for
 * an egg and another for a Pokémon would reflow every time one hatched. The
 * marks are `border-box` so their 2px border is inside that figure rather than
 * four pixels on top of it, which is what makes "the same size" true rather than
 * approximately true.
 */
const COMPANION_SIZE = "192px";

/**
 * The data face.
 *
 * A system monospace stack rather than a webfont: a plugin bundle that shipped
 * a font file would be a plugin that downloads a megabyte to render a token
 * count. Numbers on this panel are read *against* each other — a wallet against
 * a price, progress against a threshold — and tabular figures are what keeps a
 * column of them from shifting as they tick.
 */
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * A Dex specimen: the art at its native size, and the plate it sits on.
 *
 * The art is **not resized at all**, which is the point. The fetched sprites are
 * a 96px canvas drawn with `image-rendering: pixelated`, so any scale that is
 * not a whole number turns nearest-neighbour into alternating one- and
 * two-pixel rows — the reason `COMPANION_SIZE` is 192 and not 168. Here there is
 * no reason to scale at all: a record is read up close, so the honest size is
 * 1:1 and the plate is what gives it presence.
 *
 * The plate is the art plus `lg` of padding on each side and a hairline: 96 +
 * 40 + 2, so 138 square. `content-box` is spelled out rather than assumed — the
 * console may or may not ship a global `border-box` reset, and whether the
 * sprite renders at 96 or at 54 should not depend on finding out.
 */
const DEX_SPECIMEN = "96px";
const DEX_PLATE_PAD = SPACE.lg;

export const Panel = styled.section`
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: ${SPACE.lg};
  color: var(--ink);
`;

/**
 * A section heading with its rule running out to the margin.
 *
 * The rule is the structure: four zones on one panel, each announced the same
 * way, so an operator scanning for the shop finds it in the same place every
 * time. It is not a divider between paragraphs — it belongs to the heading and
 * starts where the words stop.
 */
export const SectionHead = styled.h3`
  display: flex;
  align-items: center;
  gap: ${SPACE.md};
  margin: ${SPACE.xl} 0 ${SPACE.md};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-dim);

  &::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--rule);
  }
`;

/**
 * A section heading that folds, which needs its rule as an element.
 *
 * `SectionHead` draws its rule with `::after`, which is always the last thing in
 * the box — fine for a heading that is only words, wrong here, because the count
 * has to sit on the far right *past* the rule. So the pseudo-element is switched
 * off and `SectionRule` takes its place in the middle of the row. `KeyPicker`
 * still uses the plain heading and still wants the `::after` version, which is
 * why this is a variant rather than a change to the original.
 */
export const FoldingHead = styled(SectionHead)`
  &::after {
    content: none;
  }
`;

/** The rule, as an element, so something can be placed after it. */
export const SectionRule = styled.span`
  flex: 1;
  height: 1px;
  background: var(--rule);
`;

/**
 * The control that folds a section away, filling the heading it sits in.
 *
 * A `button` with `aria-expanded` rather than a `details`/`summary` pair. Both
 * are accessible; this one is the panel's existing idiom — the rarity filters
 * already carry their state in an `aria-*` attribute on a button — and it is
 * what this panel's tests can assert against, since they are written about
 * roles and accessible names rather than about markup.
 *
 * Unstyled as a button on purpose: it *is* the heading, so a border or a raised
 * background would make four section titles look like four controls sitting
 * above the content rather than like the titles of it. What says it is
 * clickable is the marker and the cursor.
 */
export const SectionToggle = styled.button`
  display: flex;
  align-items: center;
  gap: ${SPACE.sm};
  flex: 1;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 2px;
  }
`;

/**
 * The disclosure marker, rotated rather than swapped.
 *
 * One glyph at two angles, so the open and closed states cannot drift apart in
 * size or baseline the way `▸` and `▾` do — they are different widths in several
 * of the fonts a console might be set in, and the heading shifts sideways as a
 * section is folded. It is `aria-hidden` because `aria-expanded` on the button
 * already says this, and a screen reader announcing a triangle after the word
 * "expanded" is noise.
 */
export const SectionMarker = styled.span<{ $open: boolean }>`
  display: inline-block;
  font-size: 9px;
  line-height: 1;
  transform: rotate(${(p) => (p.$open ? "90deg" : "0deg")});
  transition: transform 120ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/**
 * What a folded section still says about itself.
 *
 * The whole reason a collapsed heading is not just a word: "BAG" tells an
 * operator nothing they did not already know, and "BAG · 3 held" tells them
 * whether opening it is worth the click.
 */
export const SectionCount = styled.span`
  color: var(--ink-faint);
  letter-spacing: 0.08em;
  white-space: nowrap;
`;

export const Row = styled.div`
  display: flex;
  gap: ${SPACE.md};
  align-items: center;
  flex-wrap: wrap;
`;

/**
 * A panel's title line: the heading, what it is showing, and the way back.
 *
 * `Row` centres its children, and that is only the same as centring them on the
 * *heading* when the heading's own margins are symmetric. A heading is a block
 * element carrying whatever margin the console's reset gives it — commonly some
 * below and none above — and flex centres the margin box, so the words sit high
 * while the key id and the button sit on the row's true middle. The heading is
 * the tallest thing here, so it is the one that has to give up its margin;
 * standalone headings elsewhere keep theirs.
 */
export const PanelHead = styled(Row)`
  h2 {
    margin: 0;
  }
`;

export const Dim = styled.span`
  color: var(--ink-dim);
`;

/**
 * A dimmed fact that takes a line of its own.
 *
 * `Dim` is a span, which is right where it sits inside a sentence and wrong
 * where two of them are stacked as separate facts. Adjacent inline elements with
 * only a JSX newline between them render with **no separator at all** — JSX
 * strips whitespace containing a newline — so "Stage 1 of 2" followed by "76.9M
 * / 250.0M to the next stage" came out as `Stage 1 of 276.9M / 250.0M`. Which
 * does not merely look cramped: it reads as a companion sitting 26.9M past a
 * threshold it should already have evolved through, so the first thing it costs
 * is trust in the growth meter.
 *
 * Its top margin is the one `ChipRow` puts below itself, deliberately the same
 * value: the name, the qualifiers, the meter and the numbers beneath it are one
 * column, and four elements each picking their own gap is how a column stops
 * looking like one.
 */
export const Fact = styled(Dim)`
  display: block;
  margin-top: ${SPACE.sm};

  /* Two facts about one meter are closer to each other than either is to the
     meter, because that is what they are: "stage 1 of 2" and the tokens under
     it are one reading, not two. Spaced evenly they read as a list of unrelated
     numbers that happen to be stacked. */
  & + & {
    margin-top: ${SPACE.xs};
  }
`;

/**
 * The line under a panel heading that says what the panel is for.
 *
 * A styled `p` rather than a bare one wrapping a `Dim`. A bare paragraph
 * inherits whatever margin the console's own reset leaves it — a number this
 * panel neither chose nor can see, and one that can change underneath it without
 * anything here rendering differently in a test. Its bottom margin is the
 * panel's `lg` step, so the roster starts at the same distance a section heading
 * would.
 */
export const Lede = styled.p`
  color: var(--ink-dim);
  margin: ${SPACE.xs} 0 ${SPACE.lg};
`;

export const Notice = styled.p`
  color: var(--warn);
  background: var(--warn-wash);
  border-radius: 6px;
  padding: ${SPACE.md};
  margin: ${SPACE.md} 0 0;
`;

/**
 * A fact about the thing being shown: its rarity, its nature, its guarantee.
 *
 * One shape for all of them, and no colour. Giving rarity a hue would make the
 * panel the only surface in the console where colour means neither provider nor
 * health, and it would still need the word underneath to be readable.
 */
export const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${SPACE.xs};
  padding: 2px ${SPACE.sm};
  border: 1px solid var(--rule);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-dim);
  white-space: nowrap;
`;

/**
 * The band of chips under the companion's name.
 *
 * A `Row` of its own rather than the bare one, because this is the only row on
 * the panel with a meter directly beneath it. `Row` carries no vertical margin —
 * correctly, since most of its uses are a line of controls — so the qualifiers
 * sat flush against the growth track and read as part of it, and a chip that
 * wrapped to a second line touched it outright.
 */
export const ChipRow = styled(Row)`
  margin: ${SPACE.xs} 0 ${SPACE.sm};
`;

/** The one chip that is emphasised, because a shiny is a 1-in-64 fact. */
export const ShinyChip = styled(Chip)`
  border-color: var(--rule-strong);
  color: var(--ink);
  font-weight: 600;
`;

/**
 * The companion itself, on nothing.
 *
 * No fill and no frame, deliberately. These are transparent GIFs, so a sunk
 * background and a rule were a box drawn *behind* the Pokémon rather than around
 * it — in the dark theme that reads as a black plate the sprite is sitting on,
 * which is the one place on the panel where a surface appeared that no data
 * asked for. The egg and the unreadable mark keep theirs because they are drawn
 * shapes: the box *is* the graphic there, where here it only obscured one.
 */
export const Sprite = styled.img`
  width: ${COMPANION_SIZE};
  height: ${COMPANION_SIZE};
  image-rendering: pixelated;
`;

/**
 * An egg, drawn — now the *fallback* for one that could not be fetched.
 *
 * It used to be the only egg there was, on the reasoning that the species
 * sprite route parses its parameter as an integer so `/sprite/egg` is a
 * guaranteed 400. That is still true; what changed is that the *item* sprite
 * route looks its parameter up in a closed map, and the map now has an entry
 * for an unhatched companion. So the egg is fetched like everything else and
 * this shape is what shows when it cannot be: a cold cache on first paint, or
 * an install with no `net` where the route answers 503 forever.
 *
 * Which is why it keeps its full 192px rather than shrinking to match the
 * artwork below. It is a drawn shape and not a picture of one — the box *is*
 * the graphic — so it should fill the slot the sprite is centred in.
 */
export const EggMark = styled.div`
  box-sizing: border-box;
  width: ${COMPANION_SIZE};
  height: ${COMPANION_SIZE};
  border-radius: 50% 50% 45% 45%;
  background: var(--panel-sunk);
  border: 2px solid var(--rule-strong);
`;

/**
 * The fetched egg, and the reason it is 180px rather than 192px.
 *
 * Upstream has no large egg art: `sprites/pokemon/` holds none at all, and both
 * egg files under `sprites/items/` are **30×30**. At `COMPANION_SIZE` that is a
 * 6.4× upscale, and nearest-neighbour turns a fractional scale into alternating
 * six- and seven-pixel source pixels — the same lumpiness the 192px figure was
 * chosen to avoid for the 96px species sprites, arrived at from the other
 * direction. 30 × 6 = 180 is exact.
 *
 * The *slot* stays `COMPANION_SIZE`, so an egg and a hatched companion occupy
 * the same space and the roster does not reflow the moment one hatches. The
 * image is centred in it; the twelve pixels of margin are invisible against a
 * transparent PNG.
 */
export const EggSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${COMPANION_SIZE};
  height: ${COMPANION_SIZE};
`;

export const EggImage = styled.img`
  width: 180px;
  height: 180px;
  image-rendering: pixelated;
`;

/**
 * A save that could not be read, which is not an egg and must not look like one.
 *
 * Square where the egg is round, and dashed where everything else on the panel
 * is solid — a shape that says "missing" rather than "not yet". `--warn` is the
 * one colour here that is doing what the console says colour is for: this is a
 * claim about health.
 */
export const BrokenMark = styled.div`
  box-sizing: border-box;
  width: ${COMPANION_SIZE};
  height: ${COMPANION_SIZE};
  border-radius: 6px;
  background: var(--warn-wash);
  border: 2px dashed var(--warn);
`;

export const Button = styled.button`
  background: var(--panel-raised);
  border: 1px solid var(--rule);
  border-radius: 6px;
  color: var(--ink);
  padding: ${SPACE.sm} ${SPACE.md};
  font: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--rule-strong);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  &[aria-pressed="true"] {
    background: var(--accent-wash);
    border-color: var(--accent);
    color: var(--ink);
  }
  &:disabled {
    color: var(--ink-faint);
    cursor: not-allowed;
  }
`;

/** A price, or a count, or a threshold. Anything read against another number. */
export const Numeric = styled.span`
  font-family: ${MONO};
  font-variant-numeric: tabular-nums;
`;

/* -------------------------------------------------------------------------- */
/* the evolution track                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The panel's one distinctive element, and it is distinctive because it is the
 * data rather than a decoration of it.
 *
 * A companion's save holds `plannedPath` — the whole line it will grow through —
 * and `stageIndex`, where it currently stands. A single progress bar can only
 * answer "how far to the next evolution"; this answers "how far through the
 * line", which is the question somebody watching a companion grow actually has.
 * Segments behind the current stage are full, the current one carries the real
 * progress, and the ones ahead are empty.
 *
 * An egg has no line yet — its species is not rolled until it hatches — so it
 * gets exactly one segment. Drawing three empty ones would be inventing a shape
 * the save does not have.
 */
export const Track = styled.div`
  display: flex;
  gap: 3px;
  min-width: 240px;
  max-width: 340px;
`;

export const Segment = styled.div`
  flex: 1;
  height: 10px;
  background: var(--panel-sunk);
  border: 1px solid var(--rule);
  border-radius: 3px;
  overflow: hidden;
`;

/**
 * The filled part of a segment.
 *
 * A `transition`, deliberately not a keyframe animation. The panel refetches on
 * an interval, so a keyframe would replay from zero on every poll that moved the
 * number — the bar would collapse and regrow on every poll, which reads
 * as a companion losing its progress rather than gaining any. A transition
 * animates from the width that was already there to the new one, which is both
 * the correct picture and the only one that stays still when nothing changed.
 *
 * It is also the panel's only motion. This lives in an ops console, a surface
 * people open during an incident; anything more would be movement competing with
 * the dashboard next to it.
 */
export const SegmentFill = styled.div<{ $pct: number }>`
  height: 100%;
  background: var(--accent);
  width: ${(p) => Math.min(100, Math.max(0, p.$pct))}%;
  transition: width 480ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/* -------------------------------------------------------------------------- */
/* the stat strip                                                              */
/* -------------------------------------------------------------------------- */

export const Stats = styled.dl`
  display: flex;
  flex-wrap: wrap;
  gap: ${SPACE.xl};
  margin: ${SPACE.lg} 0 0;
  padding-top: ${SPACE.lg};
  border-top: 1px solid var(--rule);
`;

export const Stat = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

export const StatLabel = styled.dt`
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
`;

export const StatValue = styled.dd`
  margin: 0;
  font-family: ${MONO};
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  color: var(--ink);
`;

/* -------------------------------------------------------------------------- */
/* grids                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The trophy case keeps its tight track, and the 84px is what a cell needs.
 *
 * A sprite is drawn at 64px, and `Cell` now carries a card's surface: 8px of
 * padding and a 1px border on each side is 18px around it, so 84 is the
 * narrowest column that cannot clip one. The two numbers move together — a card
 * with `ItemCard`'s 12px padding would need 90 — which is why the padding below
 * is `sm` rather than the shop's `md`.
 *
 * Deliberately narrower than `ItemGrid`. The shop's floor comes from a sentence
 * that has to wrap readably; a Dex cell holds a number, a name and a nature, and
 * widening it to match would turn a case of forty graduates into a case of six.
 */
export const DexGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: ${SPACE.md};
`;

/**
 * One Dex cell: the sprite plus what the sprite alone cannot say.
 *
 * A button rather than a figure, on the same reasoning as `KeyCard`: the whole
 * cell opens that entry's record, and a div with a click handler would need
 * `tabIndex` and a key listener to be reachable by a keyboard that a button is
 * reachable by for free.
 *
 * The same card surface as `ItemCard`, and it replaces a cell that was drawn on
 * nothing until it was hovered or opened. A grid of transparent cells has no
 * edges, so a name that wrapped to two lines read as belonging to whichever
 * sprite it happened to sit under, and the only thing that said "this is one
 * entry" was the click that had already been made. Sunk rather than raised for
 * the same reason the shop's cards are: these sit *inside* a panel, and a raised
 * tile on a raised panel is a surface with nowhere to be.
 *
 * Selection stays a wash and an accent border rather than becoming the presence
 * of a border, because there is one now either way — `$open` changes the card's
 * colour, and hover strengthens whichever border it currently has.
 */
export const Cell = styled.button<{ $open: boolean }>`
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: ${SPACE.sm};
  background: ${(p) => (p.$open ? "var(--accent-wash)" : "var(--panel-sunk)")};
  border: 1px solid ${(p) => (p.$open ? "var(--accent)" : "var(--rule)")};
  border-radius: 8px;
  color: inherit;
  font: inherit;
  cursor: pointer;

  &:hover {
    border-color: ${(p) => (p.$open ? "var(--accent)" : "var(--rule-strong)")};
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/**
 * A species number, which is the one label a Pokémon always has.
 *
 * Mono and tabular for the reason every other number on this panel is: a column
 * of Dex cells is read down as much as across, and proportional digits make `#3`
 * and `#134` sit at different widths in the same slot. Faint, because it is the
 * identifier rather than the name — until the species cache fills in, it is also
 * the only thing there, and that is an ordinary state rather than a gap.
 *
 * `0.8em` rather than a pixel size, because this is used at two scales: in a Dex
 * cell, where it sits at the panel's body size and comes out near the 11px the
 * captions beside it use, and in the hero's heading, where a fixed 11px beside a
 * species name would read as a footnote that had drifted up a line. A number set
 * relative to its heading stays subordinate to it at any console text size.
 */
export const SpeciesNumber = styled.span`
  font-family: ${MONO};
  font-variant-numeric: tabular-nums;
  font-size: 0.8em;
  color: var(--ink-faint);
`;

/**
 * The companion's name, with its number in front of it.
 *
 * A flex heading rather than two elements and a space, so the number and the
 * name are aligned rather than merely adjacent — `align-items: baseline` is what
 * keeps a smaller mono number sitting on the same line as the name instead of
 * centred against its cap height. The gap is the panel's `sm` step for the same
 * reason every other gap here is: nothing on this panel is spaced by eye.
 *
 * The heading's accessible name is still the concatenation of both, which is
 * both correct — "#25 Pikachu" is what the heading says — and what the panel's
 * tests assert against, since they are written about roles and accessible names.
 */
export const HeroName = styled.h3`
  display: flex;
  align-items: baseline;
  gap: ${SPACE.sm};
`;

/**
 * The rarity filters, with the grid held off the bottom of them.
 *
 * `Row` carries no vertical margin — right for a line of controls inside a card,
 * wrong directly above a grid, where the first row of cells sat against the
 * buttons and read as a fifth filter that happened to have a picture on it. Now
 * that a cell has a border of its own, that collision is a visible one.
 */
export const FilterRow = styled(Row)`
  margin: 0 0 ${SPACE.md};
`;

/**
 * One species' whole record, in the top layer.
 *
 * A native `<dialog>` opened with `showModal`, which replaces a detail that was
 * placed into the grid at `grid-column: 1 / -1`. That trick was a good answer to
 * the question it was asked — it put the record under its own cell at any width
 * with no column count and no `ResizeObserver` — but it accepted two costs to do
 * it: the row went ragged while the record was open, and the grid reflowed
 * vertically under the reader every time one was. A dialog is out of flow
 * entirely, so both simply stop existing.
 *
 * Native rather than a `div` with `role="dialog"`, and the difference is not
 * cosmetic. `showModal` puts this in the top layer, above every stacking context
 * on the page without a `z-index` to lose an argument with; it traps focus; it
 * closes on Escape; and it makes the rest of the document inert. Hand-rolling
 * that is a well-known way to ship a keyboard trap that only goes one way.
 *
 * `::backdrop` is styled rather than left to the user agent's default, which is
 * an opaque-ish black that ignores the console's theme. `color-mix` against
 * `--panel-sunk` keeps it in whichever theme is loaded — the panel's rule is
 * that a hardcoded colour is the one thing on the page that will not follow the
 * theme, and a full-viewport wash is a conspicuous place to break it.
 */
export const DexDialog = styled.dialog`
  /* The close control anchors to this box rather than to the viewport, which is
     what an absolutely-positioned child of a top-layer element gets otherwise. */
  position: relative;
  margin: auto;
  width: min(520px, calc(100vw - ${SPACE.lg} * 2));
  max-height: calc(100vh - ${SPACE.xl} * 2);
  overflow: auto;
  padding: 0;
  background: var(--panel-raised);
  border: 1px solid var(--rule-strong);
  border-radius: 12px;
  box-shadow: var(--shadow);
  color: var(--ink);

  &::backdrop {
    background: color-mix(in srgb, var(--panel-sunk) 70%, transparent);
  }

  /* One transition, on open only. A record appearing instantly at full size in
     the middle of the page reads as a jump cut; 120ms of rise is enough to say
     it came from the grid. Nothing else in this dialog animates — the chain and
     the log are information, and information that moves is harder to read. */
  &[open] {
    animation: dex-record-in 120ms ease-out;
  }

  @keyframes dex-record-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    &[open] {
      animation: none;
    }
  }
`;

/**
 * The record itself, inside the dialog's box.
 *
 * A child rather than the dialog's own padding, because the backdrop test is
 * "did the click land on the dialog element itself" — and an element with
 * padding has a region that belongs to it but reads to the eye as inside the
 * card. Giving the contents their own box makes the hit areas match what is
 * drawn.
 *
 * A column of two zones rather than the sprite-beside-facts row this replaces.
 * That row was the inline detail's layout, where it was right: a detail wedged
 * into a grid has to be short. A dialog does not, and stacking six facts in one
 * column at a uniform gap left nothing saying which was the specimen and which
 * was the log.
 */
export const DexDetail = styled.div`
  display: flex;
  flex-direction: column;
`;

/**
 * The specimen plate: the sprite, and what identifies it.
 *
 * The sprite sits on `--panel-sunk` rather than on nothing, which is the
 * opposite of `Sprite`'s rule for the companion — and the difference is real.
 * The companion is the page's subject and a plate behind it is a box drawn
 * around the thing you came to see. Here the sprite is a *specimen*, one of
 * several images in a record, and the plate is what separates it from the
 * evolution tiles further down that are drawn the same way.
 */
export const DexPlate = styled.div`
  display: flex;
  align-items: center;
  gap: ${SPACE.lg};
  padding: ${SPACE.lg};

  img {
    box-sizing: content-box;
    width: ${DEX_SPECIMEN};
    height: ${DEX_SPECIMEN};
    padding: ${DEX_PLATE_PAD};
    image-rendering: pixelated;
    background: var(--panel-sunk);
    border: 1px solid var(--rule);
    border-radius: 8px;
    flex: none;
  }

  /* Below this the plate is wider than a phone, and a 128px sprite beside a
     name that has to wrap is worse than the two stacked. */
  @media (max-width: 420px) {
    flex-direction: column;
    align-items: flex-start;
    gap: ${SPACE.md};
  }
`;

/**
 * The register: everything the specimen plate does not say.
 *
 * Separated from the plate by a rule rather than by a larger gap, because the
 * two are different kinds of thing — an identity and a log — and a rule says
 * that where whitespace only says "some distance".
 */
export const DexRegister = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${SPACE.lg};
  padding: ${SPACE.lg};
  border-top: 1px solid var(--rule);
`;

/**
 * A labelled field in the register.
 *
 * The label is the panel's existing small-caps treatment — the one rarity uses —
 * rather than a new device invented for this dialog. Three of these turn a stack
 * of facts into something a reader can skip through, which is what the flat
 * column could not do.
 */
export const DexField = styled.section`
  display: flex;
  flex-direction: column;
  gap: ${SPACE.sm};
`;

/**
 * A field's value where that value is a date.
 *
 * Mono and tabular, matching the encounter rows below it — the two are the same
 * kind of fact at different scales, and setting the headline date in the body
 * face while the log is in mono would make them look unrelated.
 */
export const DexWhen = styled.span`
  font-family: ${MONO};
  font-variant-numeric: tabular-nums;
`;

export const DexFieldHead = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${SPACE.sm};
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-faint);
`;

/** The record's dismiss control, top-right of the dialog. */
export const DexClose = styled.button`
  position: absolute;
  top: ${SPACE.md};
  right: ${SPACE.md};
  /* 28px square. Smaller than the 44px a touch target wants, and deliberately:
     this is a modal with three other ways out — Escape, the backdrop, and the
     cell that opened it — so the control is a convenience rather than the only
     exit. Sized to sit inside the plate's padding without displacing it. */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--ink-faint);
  font: inherit;
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: var(--ink);
    border-color: var(--rule);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** The right-hand column of a detail: everything the sprite cannot say. */
export const DexFacts = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${SPACE.sm};
  min-width: 0;
`;

/**
 * The line this graduate grew through, drawn small.
 *
 * Wraps rather than scrolls. A three-stage line at 48px is narrower than the
 * narrowest track this grid produces, and the one thing worse than a wrapped
 * evolution line is a horizontally scrolling region inside a vertically
 * scrolling panel.
 */
/**
 * An evolution line, drawn as a chain rather than as a row.
 *
 * The stages used to be three sprites sitting `sm` apart, which reads as three
 * unrelated Pokémon that happen to be adjacent — the one thing a line is not.
 * `DexChainLink` puts a rule between them, so the sequence is stated by the
 * drawing and not left to be inferred from the order.
 *
 * Wraps, because a nine-stage Eevee branch on a narrow panel has to go
 * somewhere. `align-items: stretch` keeps the tiles a common height when one
 * caption wraps to two lines and its neighbours do not.
 */
export const DexLine = styled.div`
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: ${SPACE.xs};
`;

/**
 * The rule between two stages.
 *
 * `aria-hidden` at the call site: it is a picture of the relationship the order
 * already encodes, and a screen reader announcing "image" between every stage
 * would make the line harder to follow rather than easier.
 */
export const DexChainLink = styled.span`
  align-self: center;
  width: ${SPACE.md};
  height: 1px;
  background: var(--rule-strong);
  flex: none;
`;

/**
 * One stage of a line.
 *
 * `$here` marks the species whose record this is — the you-are-here of the
 * chain, and the reason the chain is worth drawing at all: it says where this
 * Pokémon sits among its own forms. Accent rather than a hue of its own, which
 * is what the panel's colour rule allows: this is *state*, the same state the
 * open cell in the grid carries, and it is drawn the same way so the two read as
 * one idea.
 *
 * The mark is not carried by colour alone. The current tile is also the only one
 * whose caption is at full `--ink`, so it is distinguishable with no colour
 * vision at all.
 */
export const DexLineStage = styled.figure<{ $here: boolean }>`
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${SPACE.xs};
  width: 76px;
  padding: ${SPACE.sm} ${SPACE.xs};
  background: ${(p) => (p.$here ? "var(--accent-wash)" : "var(--panel-sunk)")};
  border: 1px solid ${(p) => (p.$here ? "var(--accent)" : "var(--rule)")};
  border-radius: 8px;

  img {
    width: 48px;
    height: 48px;
    image-rendering: pixelated;
  }

  figcaption {
    color: ${(p) => (p.$here ? "var(--ink)" : "var(--ink-dim)")};
  }
`;

export const Caption = styled.figcaption`
  color: var(--ink-dim);
  font-size: 11px;
  text-align: center;
  overflow-wrap: anywhere;
`;

/**
 * A Dex record's title: the species number, then its name.
 *
 * `HeroName`'s shape one rank down, and an `h4` rather than the `strong` this
 * replaces. `SectionHead` and `HeroName` are both `h3`, so a record opened
 * inside a section nests correctly here — and the rank is what buys the thing
 * `strong` could not give: a `heading` role, whose accessible name is the
 * concatenation of both slots. That is what lets a test assert "#3 Venusaur" as
 * one fact rather than as two `getByText` calls that would pass with the number
 * rendered anywhere on the panel. The hero heading is asserted the same way for
 * the same reason.
 *
 * `baseline` for the reason `HeroName` gives: it is what keeps a smaller mono
 * number sitting on the name's line rather than centred against its cap height.
 * Margins zeroed because a heading's default ones are sized for prose, and this
 * one sits in a `DexFacts` column that already spaces its children.
 */
export const DexHeading = styled.h4`
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: ${SPACE.sm};
  font-size: 18px;

  /* The number is the identity in a Pokédex and the name is the annotation, so
     here it is set at the heading's own size rather than at the 0.8em
     SpeciesNumber uses elsewhere. It stays mono and faint, so it reads as a
     register mark beside the name rather than competing with it. */
  ${SpeciesNumber} {
    font-size: 1em;
  }
`;

/**
 * The individuals behind one species, newest first.
 *
 * A list and not a run of `Fact`s, because that is what it is: a species caught
 * four times has four of these, and four stacked blocks with no marker read as
 * four unrelated sentences. The marker is suppressed for the same reason the
 * roster's cards carry none — a bullet beside a date is decoration — so what
 * the list element buys here is the semantics a screen reader announces, "list,
 * four items", which is exactly the fact the eye gets from the stack.
 */
export const CatchList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
`;

/**
 * One encounter: when, what it was like, and whether it shone.
 *
 * A three-column grid rather than the `date · nature · ✦` sentence this
 * replaces. A log is read down a column — the question is "when did I catch
 * these", not "what does row two say" — and dot-separated text gives the eye no
 * column to run down. The date column is fixed so the natures line up under one
 * another whatever length the dates render at in the reader's locale.
 *
 * A hairline between rows and none above the first, so the rule reads as a
 * separator rather than as a header the list does not have.
 */
export const CatchRow = styled.li`
  display: grid;
  grid-template-columns: 11ch 1fr auto;
  gap: ${SPACE.sm};
  align-items: baseline;
  padding: ${SPACE.sm} 0;
  color: var(--ink-dim);
  font-size: 11px;

  & + & {
    border-top: 1px solid var(--rule);
  }
`;

/** The date column of an encounter: mono, so the rows align digit for digit. */
export const CatchWhen = styled.span`
  font-family: ${MONO};
  font-variant-numeric: tabular-nums;
  color: var(--ink);
`;

/** The shiny mark, held to the right edge so a column of them is scannable. */
export const CatchMark = styled.span`
  color: var(--ink);
  font-weight: 600;
`;

/**
 * The roster's track minimum is derived from `COMPANION_SIZE`, not chosen.
 *
 * 192px of companion, plus `KeyCard`'s 12px padding and 1px border on each side,
 * is 218 — so a 220px floor is the narrowest track that cannot clip a sprite.
 * The two numbers have to move together, and the previous 168px was sized
 * against a 96px companion that no longer exists.
 */
export const RosterGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: ${SPACE.md};
`;

/**
 * A roster entry: the whole card is the control.
 *
 * A button rather than a div with a click handler, so it is reachable by
 * keyboard and announced as something that can be activated without any of that
 * having to be reimplemented with `tabIndex` and a key listener.
 */
export const KeyCard = styled.button`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${SPACE.sm};
  padding: ${SPACE.md};
  background: var(--panel-raised);
  border: 1px solid var(--rule);
  border-radius: 8px;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  text-align: center;

  &:hover {
    border-color: var(--rule-strong);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** The key's own id, which is what an operator matches against the console. */
export const KeyId = styled.span`
  font-family: ${MONO};
  font-size: 12px;
  color: var(--ink-dim);
  overflow-wrap: anywhere;
`;

/* -------------------------------------------------------------------------- */
/* the item grid, shared by the shop and the bag                               */
/* -------------------------------------------------------------------------- */

/**
 * One track for both sections, and the 260px is derived rather than chosen.
 *
 * `RosterGrid`'s floor comes from the sprite it has to hold; this one comes from
 * the sentence. A forty-character measure is the comfortable floor for a blurb
 * that wraps to three lines — below it the descriptions become a column of
 * two-word lines that is slower to read than no description at all. At the
 * console's body size that is roughly 234px of text, plus `ItemCard`'s 12px of
 * padding and 1px of border on each side.
 *
 * Shared so the shop and the bag land on the same column boundaries. They are
 * the same kind of thing seen twice, and two grids that nearly line up read as a
 * mistake in a way that one grid never does.
 */
export const ItemGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: ${SPACE.md};
`;

/**
 * One offer or one held item.
 *
 * A column, and the `margin-top: auto` on its action row is the part that
 * matters. Grid stretches every cell to the tallest in its row, so cards whose
 * blurbs wrap to different depths already share a height — without pinning the
 * action to the bottom, each Buy button floats at whatever height its own text
 * ended at, and a row of them reads as scattered rather than as a set. The
 * equal heights buy nothing until something is aligned to them.
 */
export const ItemCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${SPACE.sm};
  padding: ${SPACE.md};
  background: var(--panel-sunk);
  border: 1px solid var(--rule);
  border-radius: 8px;
`;

/** The icon, the name, and the one number: everything readable at a glance. */
export const ItemHead = styled.div`
  display: flex;
  align-items: center;
  gap: ${SPACE.sm};
`;

/** The name, taking whatever the icon and the number leave. */
export const ItemName = styled.span`
  flex: 1;
  overflow-wrap: anywhere;
`;

export const ItemBlurb = styled.p`
  margin: 0;
  color: var(--ink-dim);
  font-size: 12px;
  line-height: 1.45;
`;

/**
 * The row the card's control sits on, pushed to the bottom.
 *
 * `flex-end` rather than `space-between`: the price already sits up in the head
 * beside the name, so what is left here is one control, and a lone button
 * stretched to the far left of a card is a button that looks misplaced.
 */
export const ItemAction = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: ${SPACE.sm};
  margin-top: auto;
`;

/**
 * The 32px slot an item is drawn in, whether or not there is anything to draw.
 *
 * Fixed at both sizes so the name beside it starts at the same x on every card
 * — an icon that collapsed to nothing on a cold cache would leave the shop
 * re-aligning itself as the sprites arrived, one row at a time. `flex: none`
 * because a flex child with an intrinsic image inside it is otherwise happy to
 * be squeezed by a long item name.
 */
export const ItemIconSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  font-size: 20px;
  line-height: 1;
`;

export const ItemIconImage = styled.img`
  width: 32px;
  height: 32px;
  image-rendering: pixelated;
`;
