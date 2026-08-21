/**
 * The companion's economy, ported from PokeTokenBar with its reasoning intact.
 *
 * Several of these numbers look arbitrary and are not: each one that carries a
 * comment is a bug the source app already shipped and fixed. Changing a value
 * without reading the comment above it re-introduces the bug the comment
 * describes.
 *
 * Pure by construction — no clock, no randomness, no I/O. Everything here is a
 * function of its arguments, which is what lets the whole economy be tested
 * without a database or a network.
 */

/**
 * The rarity vocabulary.
 *
 * Persisted in `rarity` on every companion and every dex entry, so this is a
 * storage contract rather than an internal enum. Adding a name is free;
 * renaming or removing one loses every row that used it.
 */
export const RARITIES = ["common", "uncommon", "rare", "legendary"] as const;

export type Rarity = (typeof RARITIES)[number];

/** A rarity a fresh egg can guarantee. Legendary is deliberately absent — see `freshEggPrice`. */
export type GuaranteedTier = Exclude<Rarity, "legendary">;

/**
 * Rank within `RARITIES`, ascending by value.
 *
 * The only consumer is the premium egg's guarantee gate, which refuses a rolled
 * species whose rarity ranks below the tier that was paid for. Inverted, a
 * guaranteed-rare egg quietly hands back commons — which is why the ordering has
 * its own test rather than being trusted to the array's order.
 */
export function sortRank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

/**
 * The capture-rate ceiling for each rarity: at or below it, a species is at
 * least this rare.
 *
 * One source for the thresholds. PokeTokenBar learned this the hard way — the
 * classifier and the premium egg's candidate filter each had their own copy, and
 * only one of them was updated.
 *
 * `legendary` has no ceiling because it cannot be expressed as one: legendaries
 * are all capture_rate <= 45, so a rate-only rule would call them rare. They are
 * identified by their flags alone.
 */
const CAPTURE_RATE_CEILING: Record<Exclude<Rarity, "legendary">, number> = {
  rare: 45,
  uncommon: 120,
  common: 255,
};

export function rarityFromCaptureRate(
  captureRate: number,
  isLegendary: boolean,
  isMythical: boolean,
): Rarity {
  if (isLegendary || isMythical) return "legendary";
  if (captureRate <= CAPTURE_RATE_CEILING.rare) return "rare";
  if (captureRate <= CAPTURE_RATE_CEILING.uncommon) return "uncommon";
  return "common";
}

/**
 * Tokens to take a line from egg to graduation.
 *
 * Tuned in the source app against roughly 253M tokens/day on one laptop, which
 * put a common at about three days of real work and a legendary at a month. A
 * gateway fronting several clients moves far more than that, which is what the
 * operator-facing multiplier is for — see the plugin's `config.multiplier`.
 */
const GRADUATION_TOTAL: Record<Rarity, number> = {
  common: 750_000_000,
  uncommon: 1_875_000_000,
  rare: 3_000_000_000,
  legendary: 6_000_000_000,
};

export function graduationTotal(rarity: Rarity): number {
  return GRADUATION_TOTAL[rarity];
}

/**
 * Tokens to leave stage `stageIndex` of a line with `totalForms` forms.
 *
 * Weighted so stage *i* of *k* costs `T·i / (k(k+1)/2)`. Two properties fall out
 * and both are load-bearing:
 *
 * The costs sum to `T` whatever `k` is, so graduating a one-form common and a
 * three-form common cost the same. Without that, how many evolutions a species
 * happens to have becomes a difficulty setting nobody chose.
 *
 * And each stage costs more than the last, so growth decelerates as a Pokémon
 * matures rather than passing evenly.
 */
export function phaseThreshold(rarity: Rarity, totalForms: number, stageIndex: number): number {
  const forms = Math.max(1, totalForms);
  const step = stageIndex + 1;
  const denominator = (forms * (forms + 1)) / 2;
  return Math.round((graduationTotal(rarity) * step) / denominator);
}

/**
 * Tokens an egg absorbs before it hatches.
 *
 * Small next to a single stage on purpose: an egg is a prelude, not a stage of
 * its own. Whatever is spent past this carries into the hatchling.
 */
export const EGG_HATCH_THRESHOLD = 5_000_000;

/** Growth a rare candy injects. */
export const RARE_CANDY_XP = 100_000_000;

/**
 * Shop prices.
 *
 * `rareCandy` is five times the growth it grants, and that ratio is the point.
 * Tokens are both the growth meter and the wallet here, so pricing a candy at
 * its own XP would make buying one free growth — spend 100M to gain 100M. At
 * five times, earning the price already grew you more than the candy will, which
 * is what keeps the free grant from hitting a rate limit strictly better than
 * the purchase.
 *
 * `mint` only rerolls nature, which is cosmetic. There is no balance argument
 * for its price, so it is cheap enough to reroll until a nature feels right.
 *
 * `shinyCharm` is bought once and never consumed, so it is priced against a
 * whole rare graduation.
 */
export const ITEM_PRICES: Record<
  "rareCandy" | "mint" | "shinyCharm" | "everstone" | "lure" | "sootheBell" | "incense" | "repel",
  number
> = {
  rareCandy: 500_000_000,
  mint: 100_000_000,
  shinyCharm: 3_000_000_000,
  /**
   * Priced at a fresh egg, and the symmetry is the argument.
   *
   * An egg is "discard this one", a stone is "keep this one" — two opposite
   * operations at one price, which is legible from the shop row without knowing
   * anything else about the economy. It grants no growth, so the double-use trap
   * that sets the candy's price does not apply.
   *
   * It is also self-limiting: pinning a companion costs Dex progress, because a
   * pinned one never graduates. Nobody over-buys a thing that slows their own
   * collection.
   */
  everstone: 1_000_000_000,
  /**
   * A modifier rather than a replacement — the egg is still bought — so it has
   * to sit below the grade guarantee beside it. A lure plus a plain egg is 2B
   * for a guaranteed-new common, against 2.5B for a guaranteed-uncommon: novelty
   * priced below grade, which is the ordering that keeps either worth buying.
   */
  lure: 1_000_000_000,
  /**
   * Deliberately a loss in raw tokens, at every rarity.
   *
   * The bound is what makes this priceable at all. As a permanent bonus on all
   * future growth there is no price that works — any multiplier has a break-even
   * past which it is free growth forever, which is rule one of this file
   * inverted. Bounded to one companion its ceiling is `SOOTHE_BONUS` of a
   * graduation total: 187M saved on a common, 750M on a rare, 1.5B on a
   * legendary, against 3B paid.
   *
   * So it never repays itself and is least bad on the rarest companion, which
   * makes it "get this one over the line sooner" rather than an investment.
   * That asymmetry is the design, not a rough edge.
   */
  sootheBell: 3_000_000_000,
  /**
   * Cosmetic pricing, because it has no economy effect to price against.
   *
   * `phaseThreshold` sums to `T` whatever the form count, so a longer line costs
   * exactly the same to graduate and simply yields more evolutions along the
   * way. This buys events, not value.
   *
   * Note what it deliberately is *not*: a second shiny item. Stacking shiny odds
   * would re-open a decision the source app closed — it considered 1/32,
   * rejected it as excessive, and settled on 1/48 for the charm — and would put
   * two items on one axis.
   */
  incense: 500_000_000,
  /**
   * Narrower than the lure — one line excluded rather than every collected one —
   * so it prices below it, at the mint's tier.
   */
  repel: 500_000_000,
};

/**
 * How much extra growth a soothe bell adds to the companion holding it.
 *
 * Applied to what lands in `usedAtStage` and never to `tokens_total`. Growing
 * faster must not mean earning more, or an item bought with tokens would print
 * the tokens to buy the next one.
 */
export const SOOTHE_BONUS = 0.25;

export type ItemKind = keyof typeof ITEM_PRICES;

export const ITEM_KINDS = Object.keys(ITEM_PRICES) as readonly ItemKind[];

/**
 * What each purchasable thing is drawn as, and why this is a map rather than a
 * derivation.
 *
 * `sootheBell` becomes `soothe-bell` and `rareCandy` becomes `rare-candy`, so a
 * kebab-casing function would cover most of this table and would be wrong about
 * the rest — which is the entire reason it is written out. Three entries do not
 * derive:
 *
 * - `incense` has no plain sprite. PokéAPI ships nine incenses and no generic
 *   one, so this picks `luck-incense`; the plugin's incense weights a roll
 *   toward longer lines, which is the closest of the nine.
 * - `lure` has no sprite at all. `honey` is the in-game encounter-attractor and
 *   is the nearest thing in the set to what this lure does. It is knowingly art
 *   that names a different item than the label does, accepted because the
 *   alternative for an item with no sprite is no art.
 * - `mint` is **deliberately absent**. It is a Gen-8 item and the sprites
 *   repository has none, generic or otherwise, so there is nothing to point at
 *   and no near miss worth the lie — a Heart Scale is a Move Reminder token,
 *   not a nature item. It falls through to the panel's emoji, which is the same
 *   path a cold cache and an offline install already take.
 *
 * Being a closed map is also the security property. The value that reaches a URL
 * and a cache path is a lookup *result*, never a caller's string, which is the
 * same guarantee `spriteBytes` gets from validating an integer against a range.
 *
 * Written as a literal for the key checking and then published as a `Map`, and
 * the second half is not ceremony — it closes a real hole that shipped in the
 * first version of this. An object literal inherits from `Object.prototype`, so
 * `"constructor" in names` is `true` and `names.constructor` is a *function*
 * rather than `undefined`: a guard written as `=== undefined` passes it
 * straight through, and what reached the URL and the cache filename was
 * `function Object() { [native code] }.png`. A `Map` has no inherited string
 * keys, so `get` answers `undefined` for every name that is not one of these —
 * the safety is structural rather than a rule each call site has to remember.
 *
 * `Object.entries` is what bridges them, and it only yields own enumerable
 * keys, so nothing from the prototype is carried across.
 */
const ITEM_SPRITE_FILES: Readonly<Partial<Record<ItemKind, string>> & { egg: string }> = {
  rareCandy: "rare-candy",
  shinyCharm: "shiny-charm",
  everstone: "everstone",
  sootheBell: "soothe-bell",
  repel: "repel",
  incense: "luck-incense",
  lure: "honey",
  /** Every tier. The guarantee is carried by the rarity chip, not by the art. */
  egg: "lucky-egg",
};

export const ITEM_SPRITE_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(ITEM_SPRITE_FILES),
);

export const FRESH_EGG_BASE_PRICE = 1_000_000_000;

/**
 * What a fresh egg costs, optionally guaranteeing a rarity floor.
 *
 * Priced by the **graduation-total ratio**, never by the probability ratio, and
 * this is the single most important number in the file.
 *
 * By the odds — uncommon-or-better around 7.16%, rare-or-better around 6.98%,
 * call it 1:2.03 — two uncommon eggs would beat one rare egg on every axis at
 * the same spend: more rare-or-better *and* more legendaries. The higher tier
 * becomes a strictly inferior product that no informed player should ever buy,
 * which is a shop with a trap in it rather than a shop with tiers.
 *
 * By graduation totals (1 : 2.5 : 4) a tier costs what its output is worth, and
 * paying more always buys more.
 *
 * There is no legendary tier. Its floor cannot be expressed as a capture rate,
 * and the top rarity should not be a purchasable certainty — it appears in the
 * upper tiers at its natural weight instead. The type refuses it rather than a
 * runtime check, so the absence is visible where a caller would try.
 */
export function freshEggPrice(tier: GuaranteedTier | null): number {
  if (tier === null) return FRESH_EGG_BASE_PRICE;
  // Refused at runtime as well as in the type. `legendary` has a graduation
  // total like every other rarity, so the arithmetic below would happily price
  // it — and a legendary egg quietly appearing in the shop at 8B is a
  // game-design change that no error would announce.
  if ((tier as Rarity) === "legendary") {
    throw new Error("there is no legendary fresh egg; legendaries come from the upper tiers");
  }
  const multiplier = graduationTotal(tier) / graduationTotal("common");
  return Math.round(FRESH_EGG_BASE_PRICE * multiplier);
}

/** Odds denominators. Rolled against an injected seed, never against live randomness. */
export const ODDS = {
  /**
   * The mainline games use 1/4096, which on a gateway dashboard is a lifetime
   * of never seeing one. 1/64 is often enough to be a story and rare enough to
   * still be one.
   */
  shiny: 64,
  /** Holding the charm. A third better rather than doubled — the charm is a nudge. */
  shinyWithCharm: 48,
  /** Ditto's disguise, on common multi-form hatches only. */
  dittoDisguise: 128,
} as const;

/** Ditto's species id, reachable only by revealing a disguise and never by a roll. */
export const DITTO_SPECIES_ID = 132;

/**
 * The species range with animated sprites.
 *
 * The community sprite set only has Gen-V animations for the first 649. A
 * companion is a small moving thing on a panel, so a species with no animation
 * is not a candidate at all — the alternative is a still image beside moving
 * ones, which reads as broken rather than as variety.
 */
export const ANIMATED_SPECIES_MAX = 649;

export function hasAnimatedSprite(speciesId: number): boolean {
  return speciesId >= 1 && speciesId <= ANIMATED_SPECIES_MAX;
}
