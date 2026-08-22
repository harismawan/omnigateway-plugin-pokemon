import { expect, test } from "bun:test";
import { collect } from "../src/collection.ts";
import type { DexEntry } from "../src/store.ts";

/**
 * Every quantity distinct, deliberately.
 *
 * A fixture that gives the species id, the catch count and the timestamp one
 * number passes whichever two the code confuses. So ids stay small, timestamps
 * stay in the millions, and no default here is shared with another field.
 */
function row(patch: Partial<DexEntry> = {}): DexEntry {
  return {
    id: "row-1",
    baseId: 1,
    finalId: 3,
    chainOrder: [1, 2, 3],
    // Null by default, which is every graduation recorded before migration 6 —
    // the case the fallback exists for. The tests about per-stage dates set it.
    stageTimes: null,
    rarity: "common",
    isShiny: false,
    nature: "hardy",
    caughtAt: 1_000_000,
    ...patch,
  };
}

test("one graduation collects every species in the line, ascending by number", () => {
  // The whole premise: a row exists only because the individual walked all of
  // `chainOrder`, so the line is a record of what was owned rather than a guess.
  const collection = collect([row({ chainOrder: [1, 2, 3] })]);

  expect(collection.map((record) => record.speciesId)).toEqual([1, 2, 3]);
});

test("the sort is by species number and not by catch date", () => {
  // `readDex` hands rows over newest-first, so a collection that merely
  // preserved input order would look sorted on a single-line fixture and be
  // wrong the moment a second line arrived. The Venusaur line is caught later
  // and must still come first.
  const collection = collect([
    row({ id: "newer", chainOrder: [4, 5, 6], finalId: 6, caughtAt: 9_000_000 }),
    row({ id: "older", chainOrder: [1, 2, 3], finalId: 3, caughtAt: 2_000_000 }),
  ]);

  expect(collection.map((record) => record.speciesId)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a species caught twice is one record holding both catches", () => {
  // One cell per species is the point. Two rows through the same line must not
  // produce six records.
  const collection = collect([
    row({ id: "first", caughtAt: 3_000_000 }),
    row({ id: "second", caughtAt: 7_000_000 }),
  ]);

  expect(collection).toHaveLength(3);
  expect(collection.map((record) => record.catches.length)).toEqual([2, 2, 2]);
});

test("catches within a species come back newest first", () => {
  // The opposite order from the grid, and on purpose: a grid is a collection
  // and reads by number, a species' own history is a log and reads newest
  // first. Fed in the order `readDex` returns, which is already newest first.
  const collection = collect([
    row({ id: "newest", caughtAt: 8_000_000 }),
    row({ id: "middle", caughtAt: 5_000_000 }),
    row({ id: "oldest", caughtAt: 1_000_000 }),
  ]);

  expect(collection[0]?.catches.map((entry) => entry.id)).toEqual(["newest", "middle", "oldest"]);
});

test("catches come back newest first even when the rows arrive out of order", () => {
  // `readDex` orders by `caught_at DESC` today, and this must not depend on it.
  // Relying on the caller's order would make the detail's history silently
  // wrong the day that query changes.
  const collection = collect([
    row({ id: "oldest", caughtAt: 1_000_000 }),
    row({ id: "newest", caughtAt: 8_000_000 }),
    row({ id: "middle", caughtAt: 5_000_000 }),
  ]);

  expect(collection[0]?.catches.map((entry) => entry.id)).toEqual(["newest", "middle", "oldest"]);
});

test("a species is shiny when any one of its catches was", () => {
  // Shininess belongs to an individual and does not change as it evolves, so a
  // shiny Venusaur is proof of a shiny Bulbasaur owned. The rejected rule was
  // "newest catch wins", which *removes* a shiny from the collection when a
  // later ordinary individual of the same line graduates.
  const collection = collect([
    row({ id: "plain", isShiny: false, caughtAt: 6_000_000 }),
    row({ id: "sparkly", isShiny: true, caughtAt: 2_000_000 }),
  ]);

  expect(collection.map((record) => record.isShiny)).toEqual([true, true, true]);
});

test("a species with no shiny catch is not shiny", () => {
  // The other half of the rule. Without this the assertion above passes on a
  // function that hardcodes true.
  expect(collect([row({ isShiny: false })]).map((record) => record.isShiny)).toEqual([
    false,
    false,
    false,
  ]);
});

test("firstCaughtAt is the earliest catch, not the newest", () => {
  // "First caught" is the fact a Pokédex records. Taking the newest would make
  // the date move backwards through the collection as the player keeps playing.
  const collection = collect([
    row({ id: "newer", caughtAt: 9_000_000 }),
    row({ id: "older", caughtAt: 4_000_000 }),
  ]);

  expect(collection.map((record) => record.firstCaughtAt)).toEqual([
    4_000_000, 4_000_000, 4_000_000,
  ]);
});

test("a species on two branches of one chain keeps both lines, one per catch", () => {
  // Eevee. Its chain branches nine ways, so `lineThrough` gives a Vaporeon
  // catch [133, 134] and a Jolteon catch [133, 135]. Hoisting a line onto the
  // species record would pick one winner and print "Eevee → Vaporeon" over a
  // Jolteon the player also owns, which is why `chainOrder` lives on the catch.
  const collection = collect([
    row({ id: "vaporeon", chainOrder: [133, 134], baseId: 133, finalId: 134, caughtAt: 7_000_000 }),
    row({ id: "jolteon", chainOrder: [133, 135], baseId: 133, finalId: 135, caughtAt: 3_000_000 }),
  ]);

  const eevee = collection.find((record) => record.speciesId === 133);
  expect(eevee?.catches.map((entry) => entry.chainOrder)).toEqual([
    [133, 134],
    [133, 135],
  ]);
  // And the two evolutions are their own records, each with only its own catch.
  expect(collection.map((record) => record.speciesId)).toEqual([133, 134, 135]);
  expect(collection.find((record) => record.speciesId === 134)?.catches).toHaveLength(1);
});

test("each catch keeps its own nature", () => {
  // Nature is per-individual, which is exactly why it left the cell. A record
  // that collapsed two catches to one nature would make the detail's history
  // claim both individuals were the same.
  const collection = collect([
    row({ id: "calm-one", nature: "calm", caughtAt: 6_000_000 }),
    row({ id: "brave-one", nature: "brave", caughtAt: 2_000_000 }),
  ]);

  expect(collection[0]?.catches.map((entry) => entry.nature)).toEqual(["calm", "brave"]);
});

test("rarity follows the earliest catch when two rows disagree", () => {
  // Every stage of a line shares one rarity by construction — only base forms
  // are rollable and rarity comes from the base's capture rate — so this only
  // ever decides a tie a corrupt row could invent. Written down because "they
  // are always equal" is the kind of assumption that stops being true quietly,
  // and an arbitrary winner is worse than a stated one. Earliest, because it is
  // derived from stored facts alone and so is stable across reads.
  const collection = collect([
    row({ id: "later-claim", rarity: "legendary", caughtAt: 8_000_000 }),
    row({ id: "earlier-claim", rarity: "uncommon", caughtAt: 2_000_000 }),
  ]);

  expect(collection.map((record) => record.rarity)).toEqual(["uncommon", "uncommon", "uncommon"]);
});

test("rarity breaks an exact tie by id rather than by the order rows arrived", () => {
  // `readDex` orders by `caught_at DESC` with no secondary key, so two catches
  // sharing a millisecond come back in whatever order SQLite felt like — and a
  // strict `<` would hand the rarity to whichever that was. That is the
  // arbitrary winner this module says is worse than a stated one, and the
  // catches comparator below already refuses to accept it, citing the same
  // same-millisecond collision `dexId` exists to handle.
  //
  // Fed both ways round, because a rule that depends on input order passes
  // whichever direction the fixture happens to use.
  const earlier = row({ id: "aaa", rarity: "uncommon", caughtAt: 5_000_000 });
  const later = row({ id: "bbb", rarity: "legendary", caughtAt: 5_000_000 });

  expect(collect([earlier, later]).map((record) => record.rarity)).toEqual([
    "uncommon",
    "uncommon",
    "uncommon",
  ]);
  expect(collect([later, earlier]).map((record) => record.rarity)).toEqual([
    "uncommon",
    "uncommon",
    "uncommon",
  ]);
});

test("catches sharing a millisecond come back in the same order whichever way they arrive", () => {
  // The other half of the same collision. The order need not be chronological —
  // nothing can recover that — but it must not change between two reads of the
  // same data, or a detail reshuffles itself on every poll.
  const one = row({ id: "aaa", caughtAt: 5_000_000 });
  const two = row({ id: "bbb", caughtAt: 5_000_000 });

  expect(collect([one, two])[0]?.catches.map((entry) => entry.id)).toEqual(["aaa", "bbb"]);
  expect(collect([two, one])[0]?.catches.map((entry) => entry.id)).toEqual(["aaa", "bbb"]);
});

test("ids are ordered by code unit, not by the host's collation", () => {
  // The rule the module states and the one nothing else here enforces: two
  // catches tied on the millisecond are separated by `byId`, and `byId` must
  // not be `localeCompare`. That one reads the runtime's default collation,
  // which makes the tie-break a property of the host rather than of the data.
  //
  // These two ids are what makes the difference visible, and they are the shape
  // `dexId` actually produces: `key:base:final:now:sequence`. A digit is code
  // unit 48-57 and `:` is 58, so code-unit ordering puts `1:3:` *after* `133:`;
  // CLDR root collation puts punctuation below digits and answers the other
  // way. Every other id pair in this file agrees under both, which is why a
  // realistic pair is needed rather than "aaa" and "bbb".
  //
  // Honest about its reach: on a Bun built without full ICU, `localeCompare`
  // degrades to code-unit order and this test would pass against it. That
  // asymmetry is itself the argument for not using `localeCompare`.
  const low = row({ id: "k1:1:3:1755800000000:7", caughtAt: 5_000_000 });
  const high = row({ id: "k1:133:134:1755800000000:8", caughtAt: 5_000_000 });

  // `133…` sorts first by code unit. Both directions, because a rule that
  // depends on input order passes whichever one the fixture happens to use.
  const expected = ["k1:133:134:1755800000000:8", "k1:1:3:1755800000000:7"];
  expect(collect([low, high])[0]?.catches.map((entry) => entry.id)).toEqual(expected);
  expect(collect([high, low])[0]?.catches.map((entry) => entry.id)).toEqual(expected);

  // And the same comparison settles `rarity`, so the lower id by that ordering
  // is the one whose rarity survives.
  const uncommon = row({ ...low, rarity: "uncommon" });
  const legendary = row({ ...high, rarity: "legendary" });
  expect(collect([uncommon, legendary])[0]?.rarity).toBe("legendary");
  expect(collect([legendary, uncommon])[0]?.rarity).toBe("legendary");
});

test("an empty log collects nothing", () => {
  // A key that has graduated nothing has an empty case, which the panel draws
  // as its own state rather than as a filter that hid everything.
  expect(collect([])).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* per-stage dates                                                             */
/* -------------------------------------------------------------------------- */

test("each species is dated from when its own stage was entered", () => {
  // The complaint this answers. Every stage of a line used to carry the
  // graduation instant, so a Bulbasaur raised in January was dated to the March
  // afternoon its Venusaur finished — the collection said the whole line was
  // caught in one moment, which is the one thing it certainly was not.
  const collection = collect([
    row({ chainOrder: [1, 2, 3], stageTimes: [111, 222, 333], caughtAt: 999 }),
  ]);

  expect(collection.map((record) => record.firstCaughtAt)).toEqual([111, 222, 333]);
  // And every one of them is exact, so the panel dates them plainly.
  expect(collection.map((record) => record.firstCaughtExact)).toEqual([true, true, true]);
});

test("a catch carries the instant that individual reached that species", () => {
  // The record's history, not just its headline. Species #2's list has to say
  // when this individual became an Ivysaur, not when it graduated.
  const collection = collect([
    row({ chainOrder: [1, 2, 3], stageTimes: [111, 222, 333], caughtAt: 999 }),
  ]);

  expect(collection.map((record) => record.catches[0]?.enteredAt)).toEqual([111, 222, 333]);
});

test("a graduation from before the instants were recorded falls back to its own date", () => {
  // Every Pokémon caught before migration 6 is here. The date shown is the
  // graduation, which is the only instant that row has ever held — and
  // `firstCaughtExact` is what lets the panel say so rather than pass it off as
  // the real thing.
  const collection = collect([row({ chainOrder: [1, 2, 3], stageTimes: null, caughtAt: 999 })]);

  expect(collection.map((record) => record.firstCaughtAt)).toEqual([999, 999, 999]);
  expect(collection.map((record) => record.firstCaughtExact)).toEqual([false, false, false]);
  expect(collection.map((record) => record.catches[0]?.enteredAt)).toEqual([null, null, null]);
});

test("a stage_times shorter than its chain falls back for the stages it does not cover", () => {
  // Not hypothetical: a companion that hatched before migration 6 and graduated
  // after it has instants for the stages it walked since, and none for the ones
  // it had already passed. Per stage, not all-or-nothing — throwing away a real
  // instant because its neighbour is missing would be the wrong trade.
  const collection = collect([row({ chainOrder: [1, 2, 3], stageTimes: [111], caughtAt: 999 })]);

  expect(collection.map((record) => record.firstCaughtAt)).toEqual([111, 999, 999]);
  expect(collection.map((record) => record.firstCaughtExact)).toEqual([true, false, false]);
});

test("the earliest catch of a species is decided by the stage instant, not the graduation", () => {
  // Two individuals through one line. The one that graduated *later* reached
  // Bulbasaur *earlier*, which is exactly the case a comparison on `caughtAt`
  // gets backwards — and it is the ordinary case, because a slow-growing
  // companion is one that was hatched long ago.
  const slow = row({
    id: "slow",
    chainOrder: [1, 2, 3],
    stageTimes: [100, 800, 900],
    caughtAt: 900,
  });
  const quick = row({
    id: "quick",
    chainOrder: [1, 2, 3],
    stageTimes: [500, 510, 520],
    caughtAt: 520,
  });

  const bulbasaur = collect([slow, quick])[0];
  expect(bulbasaur?.speciesId).toBe(1);
  expect(bulbasaur?.firstCaughtAt).toBe(100);
});

test("a catch list is ordered by the stage instant, newest first", () => {
  // The history of *this* species. Ordering it by graduation would put the
  // individual that reached this stage most recently in the wrong place
  // whenever the two orders disagree — which is the fixture above.
  const slow = row({ id: "slow", chainOrder: [1, 2], stageTimes: [100, 900], caughtAt: 900 });
  const quick = row({ id: "quick", chainOrder: [1, 2], stageTimes: [500, 520], caughtAt: 520 });

  const bulbasaur = collect([slow, quick])[0];
  expect(bulbasaur?.catches.map((entry) => entry.id)).toEqual(["quick", "slow"]);
  // And species #2 the other way round, because there the orders agree.
  expect(collect([slow, quick])[1]?.catches.map((entry) => entry.id)).toEqual(["slow", "quick"]);
});

test("rarity follows the catch that reached the stage first, not the one that graduated first", () => {
  // `rarity` and `firstCaughtAt` are decided together, so moving the comparison
  // to the stage instant has to move both — otherwise a record could show one
  // catch's date beside another catch's rarity.
  const slow = row({
    id: "slow",
    rarity: "uncommon",
    chainOrder: [1, 2],
    stageTimes: [100, 900],
    caughtAt: 900,
  });
  const quick = row({
    id: "quick",
    rarity: "legendary",
    chainOrder: [1, 2],
    stageTimes: [500, 520],
    caughtAt: 520,
  });

  expect(collect([slow, quick])[0]?.rarity).toBe("uncommon");
  expect(collect([quick, slow])[0]?.rarity).toBe("uncommon");
});
