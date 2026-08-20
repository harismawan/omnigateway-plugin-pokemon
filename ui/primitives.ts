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

export const Dim = styled.span`
  color: var(--ink-dim);
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

/** The one chip that is emphasised, because a shiny is a 1-in-64 fact. */
export const ShinyChip = styled(Chip)`
  border-color: var(--rule-strong);
  color: var(--ink);
  font-weight: 600;
`;

export const Sprite = styled.img`
  width: 96px;
  height: 96px;
  image-rendering: pixelated;
  background: var(--panel-sunk);
  border: 1px solid var(--rule);
  border-radius: 6px;
`;

/** An egg, drawn rather than fetched — there is no sprite for one. */
export const EggMark = styled.div`
  width: 96px;
  height: 96px;
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
  width: 96px;
  height: 96px;
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

export const RosterGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
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
