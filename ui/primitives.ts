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

/** An egg, drawn rather than fetched — there is no sprite for one. */
export const EggMark = styled.div`
  box-sizing: border-box;
  width: ${COMPANION_SIZE};
  height: ${COMPANION_SIZE};
  border-radius: 50% 50% 45% 45%;
  background: var(--panel-sunk);
  border: 2px solid var(--rule-strong);
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
 * number — the bar would collapse and regrow every fifteen seconds, which reads
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

export const DexGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: ${SPACE.md};
`;

/** One Dex cell: the sprite plus what the sprite alone cannot say. */
export const Cell = styled.figure`
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
`;

export const Caption = styled.figcaption`
  color: var(--ink-dim);
  font-size: 11px;
  text-align: center;
  overflow-wrap: anywhere;
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

/** One bag entry: what is held, how many, and what can be done with it. */
export const BagItem = styled.div`
  display: flex;
  align-items: center;
  gap: ${SPACE.sm};
  padding: ${SPACE.sm} ${SPACE.md};
  background: var(--panel-sunk);
  border-radius: 6px;
`;
