/**
 * What each item does, what to draw when there is no icon, and whether it can
 * be spent — one table, and deliberately only one.
 *
 * It holds no labels. `itemLabel` already turns `rareCandy` into "rare candy"
 * for every id here, and `format.ts` carries the warning that two derivations of
 * one label is how "rare candy" in the shop ends up beside "rareCandy" in the
 * bag. A `label` column would be that warning ignored in the same file that
 * quotes it. `CONSUMABLE_ITEMS` moved here for the opposite reason: it is a
 * *fact about an item*, so it belongs on the item's row rather than in a second
 * list that has to be kept in step with this one.
 *
 * The blurbs are copy, which is why they live in the panel rather than being
 * fetched. What that costs is written down in the design: the numbers inside
 * them are duplicated from `src/balance.ts` — 100M is `RARE_CANDY_XP`, 25% is
 * `SOOTHE_BONUS`, 1 in 48 is `SHINY_ODDS.shinyWithCharm` — and the panel cannot
 * import from `src/`, because the two halves are loaded by different runtimes.
 * A sentence here will go stale silently if one of those constants moves. That
 * is a real hazard and the reason it is stated rather than assumed.
 */

import type { Rarity } from "./types.ts";

export type ItemCard = {
  /** One sentence on what buying or spending this does. */
  blurb: string;
  /**
   * What stands in the icon's place when there is no icon.
   *
   * Not a decoration on top of the sprite — a replacement for it, and one that
   * covers three different absences with one path: `mint`, which has no sprite
   * in the PokéAPI repository and never will; a cold cache, where *every* icon
   * is missing on first paint and fills in on a later poll; and an offline
   * install, where the route answers 503 forever.
   *
   * These are full-colour glyphs, which the panel's own rule reserves for
   * provider identity and state. That exception is recorded in `DESIGN.md` and
   * is scoped to this slot: the panel already draws fetched pixel art here, and
   * an emoji standing in for it is the same kind of thing — a picture of an
   * object, not a claim about health.
   */
  emoji: string;
  /**
   * Whether the `use` route will accept this item.
   *
   * A mirror of `HELD_ITEMS` on the server, and deliberately a mirror rather
   * than a fetched fact: `shinyCharm` is passive, so posting it is a 400 and
   * offering the button would be offering a guaranteed error. The server stays
   * the enforcement — this only keeps the panel from asking.
   *
   * Being a mirror, it drifts. The failure is mild in one direction and not the
   * other: an item marked passive here that the server would spend is one the
   * panel will not offer to spend, which looks like a bug in the bag; one
   * marked spendable that the server rejects is a button that always 400s.
   * Both are visible, neither loses anything.
   */
  consumable: boolean;
};

const CATALOG: Readonly<Record<string, ItemCard>> = {
  rareCandy: {
    // "100.0M" and not "100M": `formatTokens` is what renders the price on the
    // same card, and a sentence quoting a token figure in a different style
    // from the number beside it reads as a different quantity.
    blurb: "Injects 100.0M growth. Priced at five times what it grants.",
    emoji: "🍬",
    consumable: true,
  },
  mint: {
    blurb: "Rerolls this companion's nature. Cosmetic, and cheap enough to reroll again.",
    emoji: "🌿",
    consumable: true,
  },
  shinyCharm: {
    blurb: "Kept, never spent. Raises every future hatch from 1 in 64 to 1 in 48.",
    emoji: "✨",
    consumable: false,
  },
  everstone: {
    blurb: "Pins this companion: it will not evolve, reveal, or graduate.",
    emoji: "🪨",
    consumable: true,
  },
  lure: {
    blurb: "Next egg prefers a species the Dex has not collected. A preference, never a veto.",
    emoji: "🍯",
    consumable: true,
  },
  sootheBell: {
    blurb: "This companion grows 25% faster. Bound to it, and never repays its price.",
    emoji: "🔔",
    consumable: true,
  },
  incense: {
    blurb: "Next egg leans toward a longer evolution line. Buys events, not value.",
    emoji: "🕯️",
    consumable: true,
  },
  repel: {
    blurb: "Next egg will not hatch one named line.",
    emoji: "🚫",
    consumable: true,
  },
};

/**
 * The card for an item, including one this table has never heard of.
 *
 * Copy fails open, which is the `readDex` half of the repository's rule rather
 * than the `parseState` half — no money moves through this function. An item the
 * server sells that nobody has written a sentence for still gets a row and a
 * placeholder glyph, and `itemLabel` still names it. A missing description is
 * not a missing item, and a shop that dropped an offer because its copy was
 * unwritten would hide a thing an operator can actually buy.
 *
 * It is marked spendable, deliberately. The two failures are not symmetric: an
 * unknown item treated as passive can never be spent from the panel at all,
 * while one treated as spendable offers a button the server refuses with a
 * message the panel already shows. A visible refusal beats a silent omission.
 */
export function itemCard(item: string): ItemCard {
  return (
    CATALOG[item] ?? {
      blurb: "",
      emoji: "❔",
      consumable: true,
    }
  );
}

/** Items the `use` route will accept, read off the one table that names them. */
export const CONSUMABLE_ITEMS: readonly string[] = Object.entries(CATALOG)
  .filter(([, card]) => card.consumable)
  .map(([item]) => item);

/** The egg is not an item and has no id, so its copy is a function, not a row. */
export const EGG_EMOJI = "🥚";

export function eggBlurb(tier: Rarity | null): string {
  return tier === null
    ? "Sends this companion off and starts again."
    : `Sends this companion off for an egg guaranteed to hatch ${tier} or better.`;
}
