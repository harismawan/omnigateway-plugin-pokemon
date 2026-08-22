/**
 * The graduation log read as a species collection.
 *
 * Pure, and separate from `store` for the reason `advance`, `roll` and
 * `balance` are: every rule below can be tested exhaustively without a
 * database, a renderer, or a capability stub.
 *
 * **The collection is already in the database.** Every Dex row stores
 * `chain_order`, the whole line the individual was planned to walk, and
 * `advance` emits `graduated` only once `stageIndex` has reached the last entry
 * of `plannedPath`. A row is therefore proof that the individual inhabited
 * every species in its `chain_order`, and expanding that column is a reading of
 * what the row says rather than an inference about what probably happened. That
 * is why this feature needed no migration and no backfill: a graduation
 * recorded months ago lights up its whole line the first time this runs.
 *
 * The converse is worth stating too, because it is what makes the rule safe: a
 * companion abandoned half way up its line contributes nothing, since
 * graduation is the only event that writes a row at all.
 *
 * What this deliberately does **not** feed is `collectedFinals`. That set still
 * means "lines this key has graduated" and is still built from `final_id`
 * alone. It is read by the roll's diversity weighting and by the lure's hard
 * filter, and widening it to "any stage I have seen" would make the lure skip
 * every line the player had partly walked — much stronger for an hour, then
 * useless. Collection is a display fact; rolling is not.
 */

import type { DexEntry } from "./store.ts";

/** One individual that passed through a species, as the detail's history shows it. */
export type Catch = {
  /** The Dex row's id, so a catch list has stable keys. */
  id: string;
  /**
   * The line this individual walked.
   *
   * On the catch and never hoisted onto the species, and Eevee is why: its
   * chain branches nine ways, so `lineThrough` gives a Vaporeon catch
   * `[133, 134]` and a Jolteon catch `[133, 135]`. A single line on the Eevee
   * record would have to pick one winner and would print "Eevee → Vaporeon"
   * over a Jolteon the player also owns.
   */
  chainOrder: readonly number[];
  isShiny: boolean;
  nature: string | null;
  /** When the whole line finished — the same instant for every species on it. */
  caughtAt: number;
  /**
   * When this individual reached *this* species, or null for never recorded.
   *
   * The field that makes a species record a species record. `caughtAt` is the
   * graduation, so dating a Bulbasaur by it says the whole line was caught in
   * the moment its Venusaur finished. Null for a graduation from before
   * migration 6, and for a stage that graduation had already passed when the
   * column arrived — see `enteredAtOf`.
   */
  enteredAt: number | null;
};

/** One species the key has owned, however many individuals it took. */
export type SpeciesRecord = {
  speciesId: number;
  /** From the earliest catch — see `collect` for why that tie-break and not another. */
  rarity: string;
  /** True when **any** catch that put this species in the collection was shiny. */
  isShiny: boolean;
  firstCaughtAt: number;
  /**
   * Whether `firstCaughtAt` is when this species was reached, or a stand-in.
   *
   * False when no contributing catch recorded an instant for this stage, in
   * which case `firstCaughtAt` is the earliest *graduation* instead. The panel
   * says which it is rather than presenting a graduation as a first sighting —
   * the two are the same date only for a final form.
   */
  firstCaughtExact: boolean;
  /** Newest first by stage instant, the order the log this replaces was read in. */
  catches: readonly Catch[];
};

/**
 * The species collection behind a key's graduation log.
 *
 * Ordered by species number ascending, which is how a collection is read; the
 * catches inside each record stay newest first, which is how a history is. Two
 * orders because they are two different things.
 *
 * The sort happens here rather than in SQL because the sort key does not exist
 * as a column — it comes out of expanding `chain_order`. So `readDex` keeps its
 * `caught_at DESC` and the `dex_by_key` index stays correct for the query it
 * was built for.
 *
 * **Fails open, inherited rather than re-implemented.** `readDex` already drops
 * a row whose chain will not parse and returns the rest; this consumes typed
 * rows and adds no second gate, because there is nothing left to reject. A
 * species that survives in no row is simply absent, which is the same gap
 * `readDex` already leaves.
 */
export function collect(entries: readonly DexEntry[]): SpeciesRecord[] {
  /**
   * The running answer per species.
   *
   * `first` is the earliest catch seen so far and is kept whole rather than as
   * a bare timestamp, because two fields are decided by it and both must come
   * from the *same* row: a `firstCaughtAt` from one catch beside a `rarity`
   * from another would be a record describing an individual that never existed.
   * Its id is carried for the tie-break below.
   */
  type Accumulating = {
    rarity: string;
    isShiny: boolean;
    first: Stamped;
    /** True while `first.caughtAt` is a real stage instant rather than a graduation. */
    firstExact: boolean;
    catches: Catch[];
  };
  const bySpecies = new Map<number, Accumulating>();

  for (const entry of entries) {
    for (const speciesId of entry.chainOrder) {
      // Built per species rather than once per entry, because `enteredAt` is
      // the one field on a catch that differs between the species of one line
      // — which is the whole point of it.
      const enteredAt = enteredAtOf(entry, speciesId);
      const taken: Catch = {
        id: entry.id,
        chainOrder: entry.chainOrder,
        isShiny: entry.isShiny,
        nature: entry.nature,
        caughtAt: entry.caughtAt,
        enteredAt,
      };
      // What this catch is dated by, and whether that date is the real thing.
      // Ordering falls back to the graduation so a row with no instants still
      // sorts somewhere sensible instead of sinking to the bottom forever.
      const stamp: Stamped = { id: entry.id, caughtAt: enteredAt ?? entry.caughtAt };

      const found = bySpecies.get(speciesId);
      if (found === undefined) {
        bySpecies.set(speciesId, {
          rarity: entry.rarity,
          isShiny: entry.isShiny,
          first: stamp,
          firstExact: enteredAt !== null,
          catches: [taken],
        });
        continue;
      }

      found.catches.push(taken);
      // Any catch, not the newest, and written as an OR so it can only ever be
      // set. Shininess belongs to an individual and does not change as it
      // evolves, so a shiny Venusaur is proof of a shiny Bulbasaur owned — and
      // a rule that let a later ordinary individual clear the mark would be a
      // collection that can lose things.
      found.isShiny = found.isShiny || entry.isShiny;

      // Earliest wins, and the two fields it decides move together. `first` is
      // what "first caught" means to a Pokédex; `rarity` rides along because
      // every stage of a line shares one by construction — only base forms are
      // rollable and rarity comes from the base's capture rate — so this only
      // ever settles a tie a corrupt row could invent. Earliest rather than
      // rarest because it is derived from stored facts alone and so is stable
      // across reads, the same property that makes a retried roll the same roll.
      //
      // Compared on the *stage* instant, which is what `stamp` carries. On the
      // graduation it would be wrong in the ordinary case rather than a rare
      // one: a slow-growing companion reaches Bulbasaur long before a quick one
      // and graduates long after it, so the two orders disagree exactly when
      // the collection is interesting.
      if (earlier(stamp, found.first)) {
        found.rarity = entry.rarity;
        found.first = stamp;
        found.firstExact = enteredAt !== null;
      }
    }
  }

  return [...bySpecies]
    .map(([speciesId, found]) => ({
      speciesId,
      rarity: found.rarity,
      isShiny: found.isShiny,
      firstCaughtAt: found.first.caughtAt,
      firstCaughtExact: found.firstExact,
      // Sorted here rather than trusted from the caller. `readDex` returns
      // `caught_at DESC` today, and a history that silently depended on that
      // would be wrong the day the query changes. Keyed on the stage instant
      // for the reason above, falling back to the graduation for a row that
      // never recorded one.
      catches: [...found.catches].sort(
        (a, b) => (b.enteredAt ?? b.caughtAt) - (a.enteredAt ?? a.caughtAt) || byId(a.id, b.id),
      ),
    }))
    .sort((a, b) => a.speciesId - b.speciesId);
}

/**
 * When one individual reached one species, or null if nobody wrote it down.
 *
 * Per stage rather than all-or-nothing, and the case that forces it is a
 * companion that hatched before migration 6 and graduated after it: its
 * `stage_times` covers the stages it walked since the column arrived and
 * nothing before. Discarding the real instants because their neighbours are
 * missing would be the wrong trade — a known date beats a fallback, one stage
 * at a time.
 *
 * `indexOf` is safe here because a well-formed line cannot repeat a species —
 * `lineThrough` walks a tree — and a corrupt one that does simply dates both
 * occurrences from the first, which is a cosmetic wrong on a row that is
 * already wrong.
 */
function enteredAtOf(entry: DexEntry, speciesId: number): number | null {
  if (entry.stageTimes === null) return null;
  const stage = entry.chainOrder.indexOf(speciesId);
  if (stage < 0) return null;
  return entry.stageTimes[stage] ?? null;
}

/**
 * Which of two catches came first, with the same-millisecond tie broken by id.
 *
 * The tie is not hypothetical: two graduations land in one millisecond whenever
 * a large credit carries a companion through several lines at once, which is
 * the collision `dexId` mixes a counter in to survive. `readDex` orders by
 * `caught_at DESC` with no secondary key, so on a tie the row order is
 * SQLite's to choose — and a bare `<` would hand `rarity` to whichever it
 * chose. The id is not chronological and does not need to be; what it has to
 * be is the same on every read, so a detail does not reshuffle on a poll.
 */
function earlier(a: Stamped, b: Stamped): boolean {
  if (a.caughtAt !== b.caughtAt) return a.caughtAt < b.caughtAt;
  return byId(a.id, b.id) < 0;
}

/**
 * The two fields that decide which catch is first.
 *
 * Named, and the *same* type on both sides of `earlier`, so that it is a
 * lexicographic order on `(caughtAt, id)` is visible from the signature rather
 * than something a reader has to reconstruct. A `DexEntry` satisfies it
 * structurally, which is what lets the caller pass one directly.
 */
type Stamped = { id: string; caughtAt: number };

/**
 * Ids ordered by code unit, deliberately not by `localeCompare`.
 *
 * `localeCompare` with no locale argument reads the runtime's default ICU
 * collation, which makes this tie-break a property of the host rather than of
 * the data — the one thing a tie-break exists to avoid.
 */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
