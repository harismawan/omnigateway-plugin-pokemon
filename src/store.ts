import type { PluginMigration, PluginStorage } from "@omnigateway/plugin-api/define";
import type { CompanionEvent } from "./advance.ts";
import { advance } from "./advance.ts";
import { freshEggPrice, type GuaranteedTier, ITEM_PRICES, type ItemKind } from "./balance.ts";
import { type CompanionState, freshState, parseState, serialiseState } from "./state.ts";

/**
 * Three tables, not the four the design sketched.
 *
 * The species index lives in the `files` capability instead of a table, because
 * it is derived cache data fetched from a third party: `files` is already
 * excluded from database snapshots, which is exactly the property a cache wants
 * and exactly the property a snapshot wants. Putting it in a table would grow
 * every snapshot an operator downloads with data that re-fetches itself.
 */
export const MIGRATIONS: readonly PluginMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE {{companion}} (
        api_key_id   TEXT PRIMARY KEY,
        state        TEXT NOT NULL,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE {{dex}} (
        id          TEXT PRIMARY KEY,
        api_key_id  TEXT NOT NULL,
        base_id     INTEGER NOT NULL,
        final_id    INTEGER NOT NULL,
        chain_order TEXT NOT NULL,
        rarity      TEXT NOT NULL,
        is_shiny    INTEGER NOT NULL DEFAULT 0,
        nature      TEXT,
        caught_at   INTEGER NOT NULL
      )
    `,
  },
  {
    version: 3,
    // Newest first is the only order this is ever read in.
    sql: `CREATE INDEX {{dex_by_key}} ON {{dex}} (api_key_id, caught_at DESC)`,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE {{grants}} (
        api_key_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        -- An instant, not a tier. A grant is rate-limited by the window's own
        -- duration, because nothing tells this plugin when a window empties.
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (api_key_id, window_key)
      )
    `,
  },
  {
    version: 5,
    // When this key last *earned*, which `updated_at` is not: a purchase, an
    // item use and a settle all bump that, so it answers "when did the row
    // change" rather than "when did traffic arrive". The panel needs the second
    // one to say whether a companion is working or asleep.
    //
    // Nullable with no default, deliberately. A companion written before this
    // column existed has never had a credit *observed*, and backfilling
    // `updated_at` into it would invent traffic that may never have happened —
    // an idle-looking companion is a smaller lie than a working-looking one.
    sql: `ALTER TABLE {{companion}} ADD COLUMN last_credit_at INTEGER`,
  },
  {
    version: 6,
    // When each stage in `chain_order` was entered, as a JSON array parallel to
    // it. Stored because it cannot be derived: growth is counted in tokens, no
    // arithmetic over tokens yields a date, and the one table that holds
    // instants — `request_logs` — is pruned by retention and is forbidden as a
    // source here for that exact reason.
    //
    // Nullable with no default, on the same reasoning as `last_credit_at` in
    // migration 5. A graduation recorded before this column existed has no
    // observed instants, and writing `caught_at` into every slot would invent a
    // Bulbasaur date out of a Venusaur one. NULL says "never recorded", which
    // the panel renders as its own fact rather than as a date.
    sql: `ALTER TABLE {{dex}} ADD COLUMN stage_times TEXT`,
  },
  {
    version: 7,
    // Species this key has *been*, as opposed to lines it has finished.
    //
    // A fourth table rather than a nullable `caught_at` on `{{dex}}`, and the
    // reason is blast radius. `readDex` and the `collectedFinals` set both
    // assume every row they see is a graduation; a sighting row living there
    // would need a guard at each, and a guard missed once feeds the roll's
    // diversity weighting and the lure with species nobody graduated. A
    // separate table cannot be read by accident.
    //
    // Keyed on the species rather than on the individual, because that is the
    // question it answers — "has this key ever been a Bulbasaur" — and it is
    // what makes the write an idempotent `INSERT OR IGNORE` instead of a
    // read-modify-write. First sighting wins and is never updated, the same
    // monotonic rule the growth counters follow.
    sql: `
      CREATE TABLE {{sightings}} (
        api_key_id  TEXT NOT NULL,
        species_id  INTEGER NOT NULL,
        -- The line this individual was on, so a species seen but never
        -- graduated still has a chain to draw. There is no Dex row to take one
        -- from, and a record with no line is a sprite with nothing under it.
        chain_order TEXT NOT NULL,
        rarity      TEXT NOT NULL,
        is_shiny    INTEGER NOT NULL DEFAULT 0,
        seen_at     INTEGER NOT NULL,
        PRIMARY KEY (api_key_id, species_id)
      )
    `,
  },
];

/**
 * What a source of the collection says about a species at one moment.
 *
 * The three fields a graduation and a sighting genuinely share, named so
 * `collect` can fold both through one path rather than two near-identical ones.
 *
 * Deliberately a shared base and not a merged type. A graduation is about an
 * *individual* and carries its nature and its own instants; a sighting is about
 * a *species*. Flattening the two together would give every sighting a nature
 * column that is always null — which is the thing keeping them apart buys.
 */
export type Observed = {
  /** The line the individual behind this was on, so a record has a chain to draw. */
  chainOrder: readonly number[];
  rarity: string;
  isShiny: boolean;
};

/**
 * One graduated Pokémon.
 *
 * Rows rather than a JSON array inside the companion, and the reason is the
 * failure direction: a Dex grows without bound, the UI filters and sorts it, and
 * one corrupt entry must not take the save with it. As an array, a single bad
 * element would fail the parse of everything.
 */
export type DexEntry = Observed & {
  id: string;
  baseId: number;
  finalId: number;
  /**
   * When each stage in `chainOrder` was entered, or null for never recorded.
   *
   * Null rather than an empty array, because those are different facts: a
   * graduation from before migration 6 has no observed instants, and one that
   * somehow stored an empty list would be a bug worth seeing. The panel dates a
   * null line from `caughtAt` and says that is what it did.
   */
  stageTimes: readonly (number | null)[] | null;
  nature: string | null;
  caughtAt: number;
};

export type CompanionRow = {
  apiKeyId: string;
  /** Null when the stored save could not be read — never a fresh companion. */
  state: CompanionState | null;
  /**
   * The stored save exactly as the column holds it.
   *
   * Kept because it is what every write compares against. A gateway is a fleet
   * now: two replicas settle, buy and grant against one row, and `state` is
   * read-modify-written across an `await` on every one of those paths — so the
   * write has to say *which* save it is replacing. Re-serialising the parsed
   * state would not do: `parseState` clamps, defaults and drops, so a save that
   * round-trips to different bytes would never match itself and no write would
   * ever land.
   */
  raw: string;
  tokensTotal: number;
  tokensSpent: number;
  /** When tokens last landed, or null for a row that predates the column. */
  lastCreditAt: number | null;
};

/** Spendable balance. Growth is never rewound by a purchase; only this shrinks. */
export function wallet(row: CompanionRow): number {
  return Math.max(0, row.tokensTotal - row.tokensSpent);
}

type StoredCompanion = {
  api_key_id: string;
  state: string;
  tokens_total: number;
  tokens_spent: number;
  last_credit_at: number | null;
};

export async function readCompanion(
  storage: PluginStorage,
  apiKeyId: string,
): Promise<CompanionRow | null> {
  const row = await storage.get<StoredCompanion>(
    `SELECT api_key_id, state, tokens_total, tokens_spent, last_credit_at
     FROM {{companion}} WHERE api_key_id = $1`,
    [apiKeyId],
  );
  if (row === null) return null;
  return {
    apiKeyId: row.api_key_id,
    state: parseState(row.state),
    raw: row.state,
    tokensTotal: row.tokens_total,
    tokensSpent: row.tokens_spent,
    // Taken straight from the column. A `?? null` here was tried and deleted:
    // migration 5 gives every row the column and `bun:sqlite` hands back SQL
    // NULL as `null`, so the coalesce could not change an outcome — and no
    // mutation of it could fail a test, which is the definition of decoration.
    lastCreditAt: row.last_credit_at,
  };
}

/**
 * Every key that has a companion, most recent earner first.
 *
 * This is what a plugin *can* enumerate. It is not the host's key list — no
 * capability offers that, and the design said so — but it is the set that
 * matters to this panel: a key with no row has never spent a token, so it has
 * no companion to show and nothing a picker could usefully offer.
 *
 * **Fails open, like `readDex` and unlike `settle`.** An unreadable save comes
 * back with `state: null` and keeps its place. Dropping it would make a corrupt
 * companion invisible on the one surface that lists companions, which is where
 * an operator would go looking for it.
 *
 * `last_credit_at IS NULL` leads the ordering rather than `NULLS LAST`: SQLite
 * sorts NULL as smallest, so a bare `DESC` floats every never-observed key to
 * the top of the roster. Written as a boolean key it needs no version of SQLite
 * newer than the one the gateway happens to link.
 */
export async function listCompanions(storage: PluginStorage): Promise<CompanionRow[]> {
  const rows = await storage.all<StoredCompanion>(
    `SELECT api_key_id, state, tokens_total, tokens_spent, last_credit_at
     FROM {{companion}}
     ORDER BY last_credit_at IS NULL, last_credit_at DESC, tokens_total DESC, api_key_id ASC`,
  );
  return rows.map((row) => ({
    apiKeyId: row.api_key_id,
    state: parseState(row.state),
    raw: row.state,
    tokensTotal: row.tokens_total,
    tokensSpent: row.tokens_spent,
    lastCreditAt: row.last_credit_at,
  }));
}

/**
 * Credits tokens to a key, creating its companion on first sight.
 *
 * Created lazily rather than when a key is minted: a companion measures from
 * install forward, so a key that has never been used has nothing to show and
 * nothing to store. That is also why there is no backfill anywhere in this
 * plugin — see the growth notes in the design.
 *
 * The counter only ever increases. It is never recomputed from `request_logs`,
 * because retention prunes that table and a recomputed meter would run backwards
 * after a sweep — a Pokémon de-evolving because an operator tidied a database.
 *
 * This is the **only** site that writes `last_credit_at`. Purchases, item uses
 * and settles all move `updated_at` and must leave this one alone, or the
 * panel's activity state would read a shopping trip as work.
 */
export async function creditTokens(
  storage: PluginStorage,
  apiKeyId: string,
  tokens: number,
  now: number,
): Promise<boolean> {
  // Reports whether it wrote, for the reason `settle` does. The host emits a
  // `RequestCompleted` for a failed request too, and that request carries no
  // tokens — so this early return is the common case during a provider outage,
  // not an edge. A caller that assumed a credit always writes would push a frame
  // per failed request naming a key that may not even have a row.
  if (tokens <= 0) return false;
  await storage.run(
    `INSERT INTO {{companion}} (api_key_id, state, tokens_total, tokens_spent, created_at, updated_at, last_credit_at)
     VALUES ($1, $2, $3, 0, $4, $5, $6)
     ON CONFLICT(api_key_id) DO UPDATE SET
       tokens_total = tokens_total + excluded.tokens_total,
       updated_at = excluded.updated_at,
       last_credit_at = excluded.last_credit_at`,
    [apiKeyId, serialiseState(freshState()), Math.trunc(tokens), now, now, now],
  );
  return true;
}

/**
 * Replaces one save with another, and reports whether this caller is the one
 * that did it.
 *
 * **Every write to `state` goes through here**, which is the whole point: a
 * guard at one site is a guard the next site forgets. `expected` is the row as
 * it was read, so the `UPDATE` lands only while nothing has moved underneath —
 * on a fleet, two replicas read the same save, both compute from it, and
 * last-writer-wins silently discards one of them. For a settle that means
 * `consumedTotal` going backwards and a lifetime of tokens re-granted as
 * growth; for a purchase it means an item bought and lost.
 *
 * The outcome is read back rather than taken from a row count, because
 * `PluginStorage.run` reports none. That read costs a statement and buys the
 * only signal a caller has.
 *
 * **Two callers writing byte-identical saves both hear "yes", and that is
 * correct rather than tolerated.** Identical bytes mean identical `expected` and
 * identical intent — a double submission of one action, not two actions. Only
 * one `UPDATE` matched, so a purchase debits once and an item is added once;
 * telling the second caller it failed would report a loss that did not happen.
 * Two *different* intents can never collide this way, because the second reads
 * the first's result as its own `expected`.
 */
export async function writeState(
  storage: PluginStorage,
  apiKeyId: string,
  expected: string,
  next: CompanionState,
  now: number,
): Promise<boolean> {
  const serialised = serialiseState(next);
  await storage.run(
    "UPDATE {{companion}} SET state = $1, updated_at = $2 WHERE api_key_id = $3 AND state = $4",
    [serialised, now, apiKeyId, expected],
  );
  const after = await storage.get<{ state: string }>(
    "SELECT state FROM {{companion}} WHERE api_key_id = $1",
    [apiKeyId],
  );
  return after?.state === serialised;
}

/**
 * Applies everything the credited total has earned and writes the result back.
 *
 * Safe to call on every read: `advance` works from the difference against what
 * the state already absorbed, so a second call with an unchanged total is a
 * no-op rather than a second helping of growth.
 *
 * A save that cannot be read is left exactly as it is. Overwriting it with a
 * fresh companion would be the one irreversible thing this plugin could do to
 * somebody's months of growth, and it would do it silently.
 *
 * `wrote` reports whether the row actually moved, because the push channel's
 * invariant is a frame on every write and on no read — and this is called on
 * both paths. A caller cannot infer it from `events`: `advance` can return a
 * changed state with none, so an inference would go wrong in the direction that
 * silently costs the panel a frame.
 *
 * **The graduations are written here, after the swap this caller won.** They used
 * to be the caller's, one statement later, and on a fleet that is a window: the
 * replica that loses the swap must record nothing, and it cannot know it lost
 * until the swap has answered.
 *
 * **Deliberately not in a transaction, and that was learnt the hard way.** The
 * host's SQLite plugin storage is one connection with `BEGIN`/`COMMIT` written
 * by hand and no queue in front of it, so two overlapping
 * `storage.transaction` calls — which is what two settles are the moment one of
 * them awaits — fail outright with "cannot start a transaction within a
 * transaction". That is a single-process failure, not a cluster one, and it
 * arrives on the ordinary path: a poll settling while a credit settles. What the
 * transaction was buying is a crash window between two writes; what it cost is
 * every concurrent settle on the default backend.
 *
 * The order is the mitigation that remains. The swap first, so only one replica
 * records; the Dex rows after it, each under an id derived from the save they
 * came from, so a settle repeated over the same save files the same row rather
 * than a second one.
 *
 * Sightings stay outside, and stay the caller's, because they are recorded on
 * every settle rather than on a write — including the settles that change
 * nothing. That is what registers a companion already half way up its line.
 */
export async function settle(
  storage: PluginStorage,
  apiKeyId: string,
  now: number,
): Promise<{ row: CompanionRow; events: readonly CompanionEvent[]; wrote: boolean } | null> {
  const row = await readCompanion(storage, apiKeyId);
  if (row === null) return null;
  if (row.state === null) return { row, events: [], wrote: false };

  const result = advance(row.state, row.tokensTotal, now);
  if (result.events.length === 0 && result.state === row.state) {
    return { row, events: [], wrote: false };
  }

  const before = row.state.consumedTotal;
  const wrote = await writeState(storage, apiKeyId, row.raw, result.state, now);
  if (wrote) {
    let index = 0;
    for (const event of result.events) {
      if (event.kind !== "graduated") continue;
      await recordGraduation(
        storage,
        apiKeyId,
        {
          baseId: event.baseId,
          finalId: event.finalId,
          chainOrder: event.chainOrder,
          // Straight from the event, because the state that accumulated these
          // is discarded by the graduation that produced it. A clock read here
          // would date every stage to the settle that finished the line.
          stageTimes: event.stageTimes,
          rarity: event.rarity,
          isShiny: event.isShiny,
          nature: event.nature,
          caughtAt: now,
        },
        dexId(apiKeyId, before, index++),
      );
    }
  }

  // A replica that lost the swap reports nothing and writes nothing: the state
  // on the row is the winner's, its graduations are already recorded, and the
  // next settle reads them. Returning the events anyway would log a graduation
  // twice and push a frame for a write this process did not make.
  if (!wrote) return { row, events: [], wrote: false };
  return {
    row: { ...row, state: result.state, raw: serialiseState(result.state) },
    events: result.events,
    wrote: true,
  };
}

/**
 * A Dex row id, derived rather than minted.
 *
 * Every part is a stored fact: the key, what the save had already absorbed
 * before this settle, and which graduation of this settle it is. A retried or
 * duplicated settle over the same save therefore produces the same id, which
 * with `DO NOTHING` below makes the insert idempotent — where a counter and a
 * clock (what this was) makes two replicas mint two ids for one graduation and
 * file it twice.
 */
function dexId(apiKeyId: string, consumedBefore: number, index: number): string {
  return `${apiKeyId}:${consumedBefore}:${index}`;
}

export async function recordGraduation(
  storage: PluginStorage,
  apiKeyId: string,
  entry: Omit<DexEntry, "id">,
  id: string,
): Promise<void> {
  await storage.run(
    `INSERT INTO {{dex}} (id, api_key_id, base_id, final_id, chain_order, stage_times, rarity, is_shiny, nature, caught_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      apiKeyId,
      entry.baseId,
      entry.finalId,
      JSON.stringify(entry.chainOrder),
      // Null stays null on the way in as well as out. A caller with nothing to
      // record must not write `[]`, or "never observed" becomes indistinguishable
      // from "observed nothing" the moment it is read back.
      entry.stageTimes === null ? null : JSON.stringify(entry.stageTimes),
      entry.rarity,
      entry.isShiny ? 1 : 0,
      entry.nature,
      entry.caughtAt,
    ],
  );
}

type StoredDex = {
  id: string;
  base_id: number;
  final_id: number;
  chain_order: string;
  stage_times: string | null;
  rarity: string;
  is_shiny: number;
  nature: string | null;
  caught_at: number;
};

/**
 * A stored `chain_order`, or null for a row that can contribute no line.
 *
 * Shared by both readers because both fail open the same way and for the same
 * reason: a collection is history, so a row whose chain will not parse is a gap
 * and hiding the rest because of it would be worse. Written once so the two
 * cannot drift — a `readDex` that dropped a chain `listSightings` kept would put
 * a species in the collection that its own detail dialog could not draw.
 *
 * Non-numeric members are filtered rather than rejecting the row outright, and
 * an empty result collapses to null: a line with no species is nothing to draw,
 * which is the same outcome as a chain that would not parse at all.
 */
function parseChain(raw: string): readonly number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const chain = parsed.filter((id): id is number => typeof id === "number");
  return chain.length === 0 ? null : chain;
}

/**
 * Stored stage instants, or null for absent, unparseable, or not a list of
 * numbers.
 *
 * All three collapse to null on purpose. The panel already has to render "we
 * never recorded this" for every graduation predating migration 6, so a corrupt
 * value has a correct rendering waiting for it — and distinguishing "corrupt"
 * from "absent" on screen would be a distinction nobody can act on.
 *
 * Different from `parseChain` above, and the asymmetry is deliberate: a
 * non-numeric member is dropped there and becomes a hole here, because a missing
 * species shortens a line while a missing instant would *shift* every date after
 * it onto the wrong stage. A gap reads as a gap; a wrong date reads as a fact.
 *
 * **Holes are preserved, not rejected.** A companion part-way up its line when
 * instants started being recorded graduates with `null` in the stages nobody
 * wrote down — see `stampedAt` in `advance.ts`. Refusing the whole array over
 * them would throw away the instants that *are* real, and none of those is
 * recoverable afterwards. Mapping rather than filtering is what keeps the result
 * parallel to `chainOrder`, which `enteredAtOf` reads positionally.
 */
function parseStageTimes(raw: string | null): readonly (number | null)[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((at) => (typeof at === "number" && Number.isFinite(at) ? at : null));
}

/**
 * The Dex, newest first.
 *
 * **Fails open, the opposite of the active companion.** An entry whose chain
 * will not parse is dropped from the listing and the rest are returned. A trophy
 * case is history: losing one row is a gap, and hiding the other two hundred
 * because of it would be the worse outcome. This is the `isRtkFilterId`
 * precedent, and the contrast with `parseState` is deliberate rather than
 * inconsistent.
 */
export async function readDex(storage: PluginStorage, apiKeyId: string): Promise<DexEntry[]> {
  const rows = await storage.all<StoredDex>(
    `SELECT id, base_id, final_id, chain_order, stage_times, rarity, is_shiny, nature, caught_at
     FROM {{dex}} WHERE api_key_id = $1 ORDER BY caught_at DESC`,
    [apiKeyId],
  );

  const entries: DexEntry[] = [];
  for (const row of rows) {
    const chain = parseChain(row.chain_order);
    if (chain === null) continue;

    entries.push({
      id: row.id,
      baseId: row.base_id,
      finalId: row.final_id,
      chainOrder: chain,
      // Fails open *within* the row, which is a softer failure than the chain
      // above gets. A chain that will not parse leaves nothing to draw, so the
      // row goes; instants that will not parse cost the dates and leave a
      // graduation that is still worth showing. Both directions collapse to
      // "never recorded", which the panel already has to render for every row
      // written before migration 6.
      stageTimes: parseStageTimes(row.stage_times),
      rarity: row.rarity,
      isShiny: row.is_shiny === 1,
      nature: row.nature,
      caughtAt: row.caught_at,
    });
  }
  return entries;
}

/**
 * One species this key has been, whether or not it ever finished the line.
 *
 * The counterpart to a `DexEntry`. The two share `Observed` and nothing else:
 * this carries only the first time the species was reached, where a graduation
 * carries the individual that reached it.
 */
export type Sighting = Observed & {
  speciesId: number;
  seenAt: number;
};

/** What `recordSightings` needs from a live companion, and nothing more. */
export type ReachedStages = {
  plannedPath: readonly number[];
  stageIndex: number;
  stageTimes: readonly (number | null)[];
  rarity: string;
  isShiny: boolean;
  /** A Ditto still wearing a disguise. Sights nothing — see below. */
  disguised: boolean;
};

/**
 * Records every stage a live companion has reached.
 *
 * **Called on every settle, not on transition events**, and the idempotence is
 * what makes that affordable: `plannedPath.slice(0, stageIndex + 1)` is exactly
 * "what this individual has been", and re-writing it is a no-op against the
 * primary key. Driving it from `hatched` and `evolved` events instead would be
 * fewer writes and would miss the case that matters most — a companion already
 * half way up its line when this shipped would go unrecorded until its next
 * evolution, which on a quiet key is weeks. Writing what is currently true
 * self-heals on the next poll instead.
 *
 * **Only what has been reached.** The stages ahead are a plan rather than a
 * history, and recording them would put a Venusaur in the collection of
 * somebody holding an Ivysaur.
 *
 * **A disguised Ditto sights nothing.** The plugin knows it is a Ditto;
 * recording the disguise would put a species in the collection that was never
 * really there, and the reveal would then have to take it away again — and this
 * table has no way to, by design.
 *
 * **Never feeds `collectedFinals`.** That set still means "lines this key has
 * graduated" and is still built from `readDex` alone. Widening it here would
 * let a reroll move the roll's diversity weighting and the lure, which is the
 * economy rather than the panel.
 */
export async function recordSightings(
  storage: PluginStorage,
  apiKeyId: string,
  reached: ReachedStages,
  now: number,
): Promise<void> {
  if (reached.disguised) return;

  const chain = JSON.stringify(reached.plannedPath);
  const stages = reached.plannedPath.slice(0, reached.stageIndex + 1);
  for (const [stage, speciesId] of stages.entries()) {
    await storage.run(
      `INSERT INTO {{sightings}} (api_key_id, species_id, chain_order, rarity, is_shiny, seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (api_key_id, species_id) DO NOTHING`,
      [
        apiKeyId,
        speciesId,
        chain,
        reached.rarity,
        reached.isShiny ? 1 : 0,
        // The instant the stage was *entered*, not the instant this ran. This
        // is called on every settle, so `now` is whenever the panel last
        // polled — taking it would date every stage of every companion alive
        // today to the first poll after this shipped. `now` is the fallback for
        // a companion that hatched before stage instants existed and so has a
        // shorter `stageTimes` than `plannedPath`: late, but the only instant
        // anybody has for it.
        reached.stageTimes[stage] ?? now,
      ],
    );
  }
}

type StoredSighting = {
  species_id: number;
  chain_order: string;
  rarity: string;
  is_shiny: number;
  seen_at: number;
};

/**
 * Every species this key has been, lowest number first.
 *
 * **Fails open, like `readDex`.** A row whose chain will not parse is dropped
 * and the rest are returned: a collection is history, so losing one entry is a
 * gap and hiding the other two hundred because of it would be worse.
 */
export async function listSightings(storage: PluginStorage, apiKeyId: string): Promise<Sighting[]> {
  const rows = await storage.all<StoredSighting>(
    `SELECT species_id, chain_order, rarity, is_shiny, seen_at
     FROM {{sightings}} WHERE api_key_id = $1 ORDER BY species_id ASC`,
    [apiKeyId],
  );

  const sightings: Sighting[] = [];
  for (const row of rows) {
    const chain = parseChain(row.chain_order);
    if (chain === null) continue;

    sightings.push({
      speciesId: row.species_id,
      chainOrder: chain,
      rarity: row.rarity,
      isShiny: row.is_shiny === 1,
      seenAt: row.seen_at,
    });
  }
  return sightings;
}

/** When this window last paid, or null for never. */
export async function lastGrantedAt(
  storage: PluginStorage,
  apiKeyId: string,
  windowKey: string,
): Promise<number | null> {
  const row = await storage.get<{ granted_at: number }>(
    "SELECT granted_at FROM {{grants}} WHERE api_key_id = $1 AND window_key = $2",
    [apiKeyId, windowKey],
  );
  return row?.granted_at ?? null;
}

/**
 * Claims a window's payout, and reports whether this caller won it.
 *
 * A compare-and-swap on the instant the caller read, for the reason `writeState`
 * is one: on a fleet two replicas see the same `LimitReached` for one key, both
 * read the same `lastGrantedAt`, and both decide to pay. An unconditional upsert
 * lets the later instant through and pays twice for one window; the swap lets
 * exactly one of them past, and the loser reads back an instant that is not its
 * own.
 *
 * `previous` is null for a window never seen, where the claim is the insert
 * itself and the conflict clause refuses the second one.
 *
 * ponytail: two replicas claiming a fresh window in the *same millisecond* both
 * read back their own instant and both pay — one extra candy, bounded by the
 * window's own rate limit. Closing it needs a claim token column and a per-write
 * nonce; add it if the seeding path ever pays something that compounds.
 */
export async function claimGrant(
  storage: PluginStorage,
  apiKeyId: string,
  windowKey: string,
  previous: number | null,
  at: number,
): Promise<boolean> {
  if (previous === null) {
    await storage.run(
      `INSERT INTO {{grants}} (api_key_id, window_key, granted_at) VALUES ($1, $2, $3)
       ON CONFLICT (api_key_id, window_key) DO NOTHING`,
      [apiKeyId, windowKey, at],
    );
  } else {
    await storage.run(
      `INSERT INTO {{grants}} (api_key_id, window_key, granted_at) VALUES ($1, $2, $3)
       ON CONFLICT (api_key_id, window_key) DO UPDATE SET granted_at = excluded.granted_at
       WHERE {{grants}}.granted_at = $4`,
      [apiKeyId, windowKey, at, previous],
    );
  }
  return (await lastGrantedAt(storage, apiKeyId, windowKey)) === at;
}

export type ShopEntry =
  | { kind: "item"; item: ItemKind }
  | { kind: "egg"; tier: GuaranteedTier | null };

export function shopPrice(entry: ShopEntry): number {
  return entry.kind === "item" ? ITEM_PRICES[entry.item] : freshEggPrice(entry.tier);
}

/**
 * Why an item declined to act, as opposed to why it could not be reached.
 *
 * Separate from `none-held` and friends because the two are different facts to
 * an operator: "you do not have one" is about the bag, and these are about the
 * companion the item was aimed at.
 */
export type ItemRefusal = "no-companion" | "nothing-new" | "already-armed" | "already-owned";

export type ConsumeResult =
  | { ok: true; row: CompanionRow }
  | { ok: false; reason: "none-held" | "unreadable" | "missing" | "stale" | ItemRefusal };

/**
 * What an item's effect returns: the state it produced, or why it did nothing.
 *
 * A plain `CompanionState` cannot express the second, which is exactly how the
 * mint bug worked — an effect with an unmet precondition returned its argument
 * unchanged, indistinguishable from an effect that ran and changed nothing.
 */
export type ItemOutcome = { applied: CompanionState } | { refused: ItemRefusal };

/**
 * Spends one held item.
 *
 * The counterpart to `purchase`, and separate from it because the two take from
 * different places: a purchase debits the wallet, this decrements inventory. A
 * granted candy was never bought, so charging for it would be charging twice.
 *
 * Refuses on an unreadable save for the same reason `purchase` does — the state
 * an effect mutates cannot be read, and writing a fresh one over it would
 * destroy what could not be read.
 *
 * **The effect runs before the item is spent, and the order is the whole point.**
 * This used to decrement first and hand the reduced inventory to the effect,
 * then write whatever came back — so an effect whose precondition was not met
 * returned its argument unchanged and the item vanished for nothing, with
 * `{ ok: true }` on the way out. A mint used on an egg was one item gone and
 * no nature rerolled. Every item has a precondition, so that was one bug per
 * item waiting to be written.
 *
 * The effect therefore sees the state as it stands, and the decrement is applied
 * to what the effect produced rather than to what it was given.
 */
export async function consume(
  storage: PluginStorage,
  apiKeyId: string,
  item: ItemKind,
  applyToState: (state: CompanionState) => ItemOutcome,
  now: number,
): Promise<ConsumeResult> {
  const row = await readCompanion(storage, apiKeyId);
  if (row === null) return { ok: false, reason: "missing" };
  if (row.state === null) return { ok: false, reason: "unreadable" };
  if ((row.state.inventory[item] ?? 0) <= 0) return { ok: false, reason: "none-held" };

  const outcome = applyToState(row.state);
  // Nothing written, nothing spent. A refusal must leave the save exactly as it
  // was, or it is not a refusal.
  if ("refused" in outcome) return { ok: false, reason: outcome.refused };

  const nextState: CompanionState = {
    ...outcome.applied,
    inventory: {
      ...outcome.applied.inventory,
      [item]: (outcome.applied.inventory[item] ?? 0) - 1,
    },
  };
  // Refused rather than retried when the save moved underneath: the effect ran
  // against a companion that no longer exists in that form, and re-running it
  // against the winner's save is a decision for whoever asked, not for a silent
  // loop that spends an item against a state nobody looked at.
  if (!(await writeState(storage, apiKeyId, row.raw, nextState, now))) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, row: { ...row, state: nextState, raw: serialiseState(nextState) } };
}

export type PurchaseResult =
  | { ok: true; row: CompanionRow }
  | { ok: false; reason: "insufficient" | "unreadable" | "missing" | "stale" | ItemRefusal };

/**
 * Buys one shop entry.
 *
 * There is still no transaction here, and the reasoning has changed twice, so it
 * is worth keeping straight. It was once argued away on the grounds that
 * `bun:sqlite` is synchronous and the process single-threaded, so nothing could
 * interleave between the read and the write. Neither half of that is true any
 * more: storage is asynchronous, and an installation is a fleet.
 *
 * What replaced it is not a transaction but a **condition on the one statement**.
 * Everything a purchase writes — the new save and the debit — moves in a single
 * `UPDATE`, which both backends apply atomically, and that `UPDATE` lands only
 * while the save is still the one that was priced and the wallet still covers
 * the price. A transaction around a read and a conditional write would add
 * nothing the condition does not already guarantee, and it would not help
 * against a throw from the caller-supplied `applyToState`, which runs before any
 * write and so has nothing to roll back.
 *
 * The wallet check is repeated *in SQL* rather than trusted from the read above
 * it: the read is what refuses politely, the predicate is what makes it true.
 * Without it two replicas both see a balance that covers one purchase and both
 * spend it, and `tokens_spent` passes `tokens_total`.
 *
 * Growth is never rewound. A purchase raises `tokens_spent` only, so no
 * evolution is ever undone by shopping.
 */
export async function purchase(
  storage: PluginStorage,
  apiKeyId: string,
  entry: ShopEntry,
  applyToState: (state: CompanionState) => ItemOutcome,
  now: number,
): Promise<PurchaseResult> {
  const price = shopPrice(entry);

  {
    const row = await readCompanion(storage, apiKeyId);
    if (row === null) return { ok: false, reason: "missing" };
    // A save that will not parse cannot be spent against: the balance is
    // readable but the state a purchase mutates is not, and writing a fresh one
    // over it would destroy what could not be read.
    if (row.state === null) return { ok: false, reason: "unreadable" };
    if (wallet(row) < price) return { ok: false, reason: "insufficient" };

    // The same channel `consume` has, and for the same reason: an effect that
    // cannot do anything must be able to say so, or it is indistinguishable
    // from one that ran and changed nothing — and here the wallet is debited
    // either way. A second shiny charm was the live instance.
    const outcome = applyToState(row.state);
    if ("refused" in outcome) return { ok: false, reason: outcome.refused };
    const nextState = outcome.applied;
    const serialised = serialiseState(nextState);
    await storage.run(
      `UPDATE {{companion}}
       SET state = $1, tokens_spent = tokens_spent + $2, updated_at = $3
       WHERE api_key_id = $4 AND state = $5 AND tokens_total - tokens_spent >= $2`,
      [serialised, price, now, apiKeyId, row.raw],
    );
    const after = await readCompanion(storage, apiKeyId);
    // Read back rather than counted, because `run` reports no row count — and
    // read as a whole row because the answer is two facts: the save is the one
    // this purchase produced, and the debit that had to accompany it landed.
    if (
      after === null ||
      after.raw !== serialised ||
      after.tokensSpent !== row.tokensSpent + price
    ) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true, row: after };
  }
}
