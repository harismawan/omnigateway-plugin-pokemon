import { expect, test } from "bun:test";
import {
  ANIMATED_SPECIES_MAX,
  DITTO_SPECIES_ID,
  ODDS,
  rarityFromCaptureRate,
} from "../src/balance.ts";
import { NATURES, type Roll, roll, type SpeciesCandidate } from "../src/roll.ts";
import { emptyInventory, freshState, hasShinyCharm } from "../src/state.ts";

/** A spread of candidates across every rarity band, all with animations. */
/**
 * Base forms only, which is what the index now emits — and every one has a
 * `finalId` distinct from its `id` where the line has evolutions, so the
 * diversity weighting is testable. It compared a candidate's own id against a
 * set of finals before, which for any multi-form line is inert.
 */
const CANDIDATES: SpeciesCandidate[] = [
  { id: 1, captureRate: 45, forms: 3, finalId: 3 }, // rare band
  { id: 10, captureRate: 255, forms: 3, finalId: 12 }, // common, multi-form → ditto-eligible
  { id: 19, captureRate: 255, forms: 2, finalId: 20 }, // common, multi-form
  { id: 100, captureRate: 190, forms: 1, finalId: 100 }, // common, single form
  { id: 144, captureRate: 3, forms: 1, finalId: 144 }, // rare band (a legendary in practice)
  { id: 200, captureRate: 90, forms: 2, finalId: 201 }, // uncommon
];

function rollWith(seed: number, over: Partial<Parameters<typeof roll>[0]> = {}): Roll | null {
  return roll({
    candidates: CANDIDATES,
    seed,
    guarantee: null,
    hasShinyCharm: false,
    collectedFinals: new Set(),
    ...over,
  });
}

/** Rolls many seeds and counts how often a predicate holds. */
function rate(predicate: (r: Roll) => boolean, count: number, over = {}): number {
  let hits = 0;
  for (let seed = 1; seed <= count; seed++) {
    const result = rollWith(seed, over);
    if (result !== null && predicate(result)) hits++;
  }
  return hits / count;
}

test("the same seed always produces the same Pokémon", () => {
  // The property the whole design turns on. Without it neither of the rare
  // events below could be asserted at all, which is why the source app has no
  // test for either of them.
  for (const seed of [1, 42, 9999]) {
    expect(rollWith(seed)).toEqual(rollWith(seed));
  }
});

test("different seeds do not all produce the same Pokémon", () => {
  // Guards the degenerate implementation that satisfies determinism by ignoring
  // the seed entirely.
  const species = new Set(
    Array.from({ length: 50 }, (_, i) => rollWith(i + 1)?.speciesId).filter((x) => x !== undefined),
  );
  expect(species.size).toBeGreaterThan(1);
});

test("a guaranteed tier never rolls below itself", () => {
  // The premium egg's whole promise. A single leak here is a paid guarantee
  // silently not honoured, which is the one bug in this file a player would
  // notice and could not prove.
  for (let seed = 1; seed <= 300; seed++) {
    const result = rollWith(seed, { guarantee: "rare" as const });
    if (result === null) continue;
    const candidate = CANDIDATES.find((c) => c.id === result.speciesId);
    expect(candidate).toBeDefined();
    expect(rarityFromCaptureRate(candidate?.captureRate ?? 255, false, false)).toBe("rare");
  }
});

test("an unsatisfiable guarantee hatches nothing rather than throwing", () => {
  // The candidate index is fetched from a third party. "Not arrived yet" has to
  // read as an egg that has not hatched, not as a crash on the request path.
  const result = roll({
    candidates: [{ id: 10, captureRate: 255, forms: 1, finalId: 10 }],
    seed: 1,
    guarantee: "rare",
    hasShinyCharm: false,
    collectedFinals: new Set(),
  });
  expect(result).toBeNull();
});

test("no candidates at all hatches nothing", () => {
  expect(rollWith(1, { candidates: [] })).toBeNull();
});

test("shiny lands near its declared odds, and the charm improves them", () => {
  // Asserted as a band rather than an exact count: this pins that the odds are
  // roughly what the constant says without freezing the PRNG's exact output,
  // which would make the test a change-detector for the algorithm.
  const plain = rate((r) => r.isShiny, 4000);
  const charmed = rate((r) => r.isShiny, 4000, { hasShinyCharm: true });

  expect(plain).toBeGreaterThan(1 / ODDS.shiny / 2);
  expect(plain).toBeLessThan((1 / ODDS.shiny) * 2);
  expect(charmed).toBeGreaterThan(plain);
});

test("a charm in the bag reaches the roll, and an empty bag does not", () => {
  // The seam nothing crossed. `hasShinyCharm` is the charm's *entire* effect —
  // 3,000,000,000 tokens buys one boolean — and the odds test above passes the
  // flag as a literal, so the function could have returned a constant `false`
  // and the shop's most expensive item would have done nothing, silently.
  //
  // Seed 452 was chosen because its shiny draw falls between 1/64 and 1/48: the
  // same egg is shiny holding the charm and not shiny without it. The species is
  // drawn before the shiny check, so it is identical either way — which is what
  // makes the difference attributable to the charm and to nothing else.
  const holding = {
    ...freshState(),
    inventory: { ...emptyInventory(), rareCandy: 0, mint: 0, shinyCharm: 1 },
  };
  const empty = freshState();

  // The seam is asserted before the flag itself, deliberately: a failure here
  // has to read as "the bag did not reach the roll" rather than as a broken
  // predicate, and an assertion on the boolean alone would let the wiring rot
  // while still going red for the right-looking reason.
  const charmed = rollWith(452, { hasShinyCharm: hasShinyCharm(holding) });
  const plain = rollWith(452, { hasShinyCharm: hasShinyCharm(empty) });

  expect(charmed?.speciesId).toBe(plain?.speciesId as number);
  expect(charmed?.isShiny).toBe(true);
  expect(plain?.isShiny).toBe(false);

  expect(hasShinyCharm(holding)).toBe(true);
  expect(hasShinyCharm(empty)).toBe(false);
});

test("a Ditto only ever disguises itself as a common multi-form species", () => {
  // A rare species turning out to be a Ditto would read as the game taking
  // something away rather than as a surprise.
  for (let seed = 1; seed <= 4000; seed++) {
    const result = rollWith(seed);
    if (result === null || !result.ditto) continue;
    const candidate = CANDIDATES.find((c) => c.id === result.speciesId);
    expect(rarityFromCaptureRate(candidate?.captureRate ?? 0, false, false)).toBe("common");
    expect(candidate?.forms ?? 0).toBeGreaterThanOrEqual(2);
  }
});

test("a Ditto is rarer than a shiny, and both actually occur", () => {
  // Both events are asserted to happen at all. A roll that never produces one
  // passes every other test in this file.
  const shinies = rate((r) => r.isShiny, 6000);
  const dittos = rate((r) => r.ditto, 6000);
  expect(shinies).toBeGreaterThan(0);
  expect(dittos).toBeGreaterThan(0);
  expect(dittos).toBeLessThan(shinies);
});

test("Ditto is never hatched directly", () => {
  // It is reachable only by revealing a disguise. In the candidate pool it
  // would otherwise be an ordinary common.
  const withDitto = [
    ...CANDIDATES,
    { id: DITTO_SPECIES_ID, captureRate: 255, forms: 1, finalId: DITTO_SPECIES_ID },
  ];
  for (let seed = 1; seed <= 500; seed++) {
    expect(rollWith(seed, { candidates: withDitto })?.speciesId).not.toBe(DITTO_SPECIES_ID);
  }
});

test("a species with no animated sprite is never chosen", () => {
  // A still sprite beside moving ones reads as broken rather than as variety.
  const withUnanimated = [
    ...CANDIDATES,
    { id: ANIMATED_SPECIES_MAX + 1, captureRate: 255, forms: 1, finalId: ANIMATED_SPECIES_MAX + 1 },
    { id: 900, captureRate: 255, forms: 1, finalId: 900 },
  ];
  for (let seed = 1; seed <= 500; seed++) {
    const id = rollWith(seed, { candidates: withUnanimated })?.speciesId ?? 0;
    expect(id).toBeLessThanOrEqual(ANIMATED_SPECIES_MAX);
  }
});

test("an already-collected species is less likely, but not impossible", () => {
  // Weighted down rather than excluded: excluding outright makes the last few
  // species unreachable once everything else is collected.
  // Down-weighted by the line's FINAL, which is the id a Dex records. Using a
  // multi-form line here is the point: with the old comparison — a candidate's
  // own id against a set of finals — this test could only ever pass for a
  // single-form species, where base and final happen to be the same number.
  const base = 10;
  const final = 12;
  const freely = rate((r) => r.speciesId === base, 2000);
  const collected = rate((r) => r.speciesId === base, 2000, {
    collectedFinals: new Set([final]),
  });

  expect(collected).toBeLessThan(freely);
  expect(collected).toBeGreaterThan(0);
});

test("every roll carries one of the 25 natures", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const nature = rollWith(seed)?.nature;
    expect(nature).toBeDefined();
    expect(NATURES).toContain(nature as (typeof NATURES)[number]);
  }
});

// --- the bought modifiers ------------------------------------------------------

test("a lure never produces a species already in the Dex", () => {
  // The difference from the diversity weighting, which is what is being bought:
  // that makes a duplicate unlikely, this makes it impossible for one hatch.
  const collectedFinals = new Set([3, 12, 100, 144]);

  for (let seed = 1; seed <= 200; seed++) {
    const result = rollWith(seed, { collectedFinals, onlyUncollected: true });
    expect(result).not.toBeNull();
    if (result === null) continue;
    const candidate = CANDIDATES.find((one) => one.id === result.speciesId);
    expect(collectedFinals.has(candidate?.finalId as number)).toBe(false);
  }
});

test("a lure with nothing left to find is dropped rather than emptying the pool", () => {
  // The lure must never be able to stop a hatch. An empty pool returns null,
  // which the caller cannot tell apart from "no candidate index yet" — so it
  // would sit at the threshold retrying identically on every poll, forever.
  const everything = new Set(CANDIDATES.map((one) => one.finalId));
  const result = rollWith(1, { collectedFinals: everything, onlyUncollected: true });

  expect(result).not.toBeNull();
  // And it says so, which is what lets the caller leave the lure armed for a day
  // when there is something new to find.
  expect(result?.usedLure).toBe(false);
});

test("a lure the guarantee rules out is dropped, not left to brick the egg", () => {
  // The case a collected-set check alone cannot see, and the one that stranded
  // 5B: every rare-or-better final collected, a guaranteed-rare egg bought, and
  // a lure armed. Uncollected species exist, so "is anything uncollected" says
  // yes — but the *intersection* with the rarity floor is empty.
  const collectedFinals = new Set([3, 144]);
  const result = rollWith(1, { collectedFinals, guarantee: "rare", onlyUncollected: true });

  expect(result).not.toBeNull();
  expect(result?.usedLure).toBe(false);
  // The guarantee is what must survive the collision: it was paid for, the lure
  // is the cheaper of the two, and a rare egg that hatches a common is the
  // failure the tier pricing exists to prevent.
  const chosen = CANDIDATES.find((one) => one.id === result?.speciesId);
  expect(rarityFromCaptureRate(chosen?.captureRate ?? 255, false, false)).toBe("rare");
});

test("a lure that can be honoured reports that it was", () => {
  // Guards the implementation that satisfies the two above by never applying
  // the filter at all.
  const result = rollWith(1, { collectedFinals: new Set([3]), onlyUncollected: true });
  expect(result?.usedLure).toBe(true);
});

test("a repel refuses the whole line, not just the form that was held", () => {
  // It names a final, so a player holding the middle form of a line is not
  // handed its base on the next roll.
  for (let seed = 1; seed <= 200; seed++) {
    const result = rollWith(seed, { excludeFinal: 12 });
    expect(result?.speciesId).not.toBe(10);
  }
});

test("a repel leaves everything else reachable", () => {
  // Guards the implementation that satisfies the test above by excluding too
  // much, or by refusing to roll at all.
  const species = new Set<number>();
  for (let seed = 1; seed <= 200; seed++) {
    const result = rollWith(seed, { excludeFinal: 12 });
    if (result !== null) species.add(result.speciesId);
  }
  expect(species.size).toBeGreaterThan(1);
});

test("an incense tilts toward longer lines without flattening rarity", () => {
  const multiForm = (r: Roll): boolean =>
    (CANDIDATES.find((one) => one.id === r.speciesId)?.forms ?? 1) > 1;

  const plain = rate(multiForm, 400);
  const incensed = rate(multiForm, 400, { preferLongLines: true });
  expect(incensed).toBeGreaterThan(plain);

  // Still a tilt and not a rewrite: the rare band is weighted by capture rate,
  // and a three-stage rare must not become common just because it is long.
  const rareRate = rate(
    (r) =>
      rarityFromCaptureRate(
        CANDIDATES.find((one) => one.id === r.speciesId)?.captureRate ?? 255,
        false,
        false,
      ) === "rare",
    400,
    { preferLongLines: true },
  );
  expect(rareRate).toBeLessThan(0.5);
});

test("the modifiers do not disturb the seed", () => {
  // They change which candidates are on the table, not which way the dice fall.
  // If a modifier consumed a random draw, an unrelated roll would shift under it
  // and a retried prefetch would stop reproducing.
  const withNone = rollWith(7, { collectedFinals: new Set() });
  const withInertRepel = rollWith(7, { collectedFinals: new Set(), excludeFinal: 999 });
  expect(withInertRepel).toEqual(withNone);
});
