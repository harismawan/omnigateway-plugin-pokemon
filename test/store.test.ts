import { afterEach, beforeEach, expect, test } from "bun:test";
import { EGG_HATCH_THRESHOLD, ITEM_PRICES } from "../src/balance.ts";
import { readCollection } from "../src/collection.ts";
import { emptyInventory, freshState, serialiseState } from "../src/state.ts";
import {
  claimGrant,
  consume,
  creditTokens,
  lastGrantedAt,
  listCompanions,
  listSightings,
  MIGRATIONS,
  purchase,
  readCompanion,
  readDex,
  recordGraduation,
  recordSightings,
  settle,
  wallet,
} from "../src/store.ts";
import { createTestStorage, type TestStorage } from "./helpers/storage.ts";

const KEY = "key_1";
let storage: TestStorage;

beforeEach(() => {
  storage = createTestStorage();
  storage.migrate(MIGRATIONS);
});

afterEach(() => {
  storage.close();
});

test("the plugin's own migrations apply and name the tables the host will name", () => {
  // Runs the placeholder expansion against real SQLite, so a migration whose
  // SQL does not parse fails here rather than at install.
  //
  // The expansion is this repository's *mirror* of the host's rule (see
  // `helpers/storage.ts`), not the host's own code — `@omni/store` is
  // unpublished, so an external plugin cannot reach it. The core-table denylist
  // is likewise host behaviour and is covered there, not here.
  expect(storage.listTables().sort()).toEqual([
    "plugin_pokemon_companion",
    "plugin_pokemon_dex",
    "plugin_pokemon_grants",
    "plugin_pokemon_sightings",
  ]);
});

test("a companion appears on first credit, not when a key is minted", async () => {
  // Measured from install forward. A key that has never been used has nothing
  // to show and nothing worth a row.
  expect(await readCompanion(storage, KEY)).toBeNull();

  await creditTokens(storage, KEY, 1_000, 1);
  expect((await readCompanion(storage, KEY))?.tokensTotal).toBe(1_000);
});

test("credits accumulate and never decrease", async () => {
  await creditTokens(storage, KEY, 1_000, 1);
  await creditTokens(storage, KEY, 2_500, 2);
  await creditTokens(storage, KEY, 0, 3);
  await creditTokens(storage, KEY, -5_000, 4);

  expect((await readCompanion(storage, KEY))?.tokensTotal).toBe(3_500);
});

test("a zero-token request writes no row and stamps no credit instant", async () => {
  // `tokens <= 0`, not `tokens < 0`, and the difference is a whole companion.
  // The accumulation test above credits 0 and asserts a total of 3,500 — which
  // is the same number whether or not the row was written — so the guard's
  // boundary was uncovered from both directions.
  //
  // A request that produced no tokens (a refusal, an empty completion) would
  // otherwise mint a companion for a key that has never earned anything and
  // stamp `last_credit_at` on it: the "working-looking companion" migration 5
  // exists to avoid, arriving through the one site allowed to write that column.
  await creditTokens(storage, KEY, 0, 111);
  expect(await readCompanion(storage, KEY)).toBeNull();
  expect((await storage.get<{ n: number }>("SELECT COUNT(*) AS n FROM {{companion}}", []))?.n).toBe(
    0,
  );

  // And against a row that does exist it moves neither the meter nor the instant.
  await creditTokens(storage, KEY, 4_000, 222);
  await creditTokens(storage, KEY, 0, 333);

  const row = await readCompanion(storage, KEY);
  expect(row?.tokensTotal).toBe(4_000);
  expect(row?.lastCreditAt).toBe(222);
});

test("settling twice does not grow twice", async () => {
  await creditTokens(storage, KEY, EGG_HATCH_THRESHOLD, 1);
  const first = await settle(storage, KEY, 2);
  const second = await settle(storage, KEY, 3);

  expect(second?.row.state).toEqual(first?.row.state as never);
  expect(second?.events).toEqual([]);
});

test("a settle reports whether it wrote, so a caller need not infer it", async () => {
  // The push channel's invariant is "a frame on every write and on no read", and
  // `GET /keys/:id` settles on the way in — so the caller has to be able to tell
  // the two apart. Inferring it from `events` would be wrong in the direction
  // that costs a frame: `advance` can move a companion without emitting one,
  // which is a state change the panel still has to hear about.
  await creditTokens(storage, KEY, EGG_HATCH_THRESHOLD, 1);

  expect((await settle(storage, KEY, 2))?.wrote).toBe(true);
  // Idempotent, and the second call is the read-shaped one: nothing changed, so
  // nothing was written and nothing should be pushed.
  expect((await settle(storage, KEY, 3))?.wrote).toBe(false);
});

test("a settle against an unreadable save reports no write", async () => {
  // It returns a row rather than null — "unreadable" and "has not started" are
  // different facts — but it must never claim to have written one.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  expect((await settle(storage, KEY, 2))?.wrote).toBe(false);
});

test("an unreadable save is left alone rather than replaced", async () => {
  // The one irreversible thing this plugin could do to months of growth, and
  // it would do it silently.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  const result = await settle(storage, KEY, 2);
  expect(result?.row.state).toBeNull();
  expect(result?.events).toEqual([]);

  const raw = await storage.get<{ state: string }>(
    "SELECT state FROM {{companion}} WHERE api_key_id = ?",
    [KEY],
  );
  expect(raw?.state).toBe("{ broken");
});

// ---------------------------------------------------------------- wallet

test("a purchase spends the wallet and never the growth meter", async () => {
  await creditTokens(storage, KEY, ITEM_PRICES.rareCandy * 2, 1);

  const result = await purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  expect(result.ok).toBe(true);

  const row = await readCompanion(storage, KEY);
  expect(row).not.toBeNull();
  if (row === null) return;
  expect(row.tokensTotal).toBe(ITEM_PRICES.rareCandy * 2);
  expect(row.tokensSpent).toBe(ITEM_PRICES.rareCandy);
  expect(wallet(row)).toBe(ITEM_PRICES.rareCandy);
});

test("a second purchase beyond the balance is refused", async () => {
  // Named for what it proves. It does NOT demonstrate a race: the two purchases
  // are awaited one after the other, so a check-then-write cannot interleave and
  // a sequential test cannot show that it can. What defends against the fleet is
  // the wallet predicate on the UPDATE itself, which this test cannot reach.
  await creditTokens(storage, KEY, ITEM_PRICES.rareCandy, 1);

  const first = await purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  const second = await purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    3,
  );

  expect(first.ok).toBe(true);
  expect(second).toEqual({ ok: false, reason: "insufficient" });
  expect((await readCompanion(storage, KEY))?.tokensSpent).toBe(ITEM_PRICES.rareCandy);
});

test("a purchase that cannot afford itself changes nothing at all", async () => {
  await creditTokens(storage, KEY, 10, 1);
  const before = await readCompanion(storage, KEY);

  const result = await purchase(
    storage,
    KEY,
    { kind: "item", item: "shinyCharm" },
    (s) => ({ applied: s }),
    2,
  );

  expect(result).toEqual({ ok: false, reason: "insufficient" });
  expect(await readCompanion(storage, KEY)).toEqual(before as never);
});

test("a purchase against an unreadable save is refused, not attempted", async () => {
  await creditTokens(storage, KEY, ITEM_PRICES.shinyCharm, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["nonsense", KEY]);

  const result = await purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  expect(result).toEqual({ ok: false, reason: "unreadable" });
  expect((await readCompanion(storage, KEY))?.tokensSpent).toBe(0);
});

test("a purchase whose effect throws debits nothing and stores nothing", async () => {
  // Holds because `applyToState` runs before any write, not because of a
  // transaction — there was one here and it could not be killed by any test,
  // so it was removed as decoration. This pins the ordering that makes it true.
  await creditTokens(storage, KEY, ITEM_PRICES.rareCandy * 2, 1);
  const before = await readCompanion(storage, KEY);

  await expect(
    purchase(
      storage,
      KEY,
      { kind: "item", item: "rareCandy" },
      () => {
        throw new Error("effect failed");
      },
      2,
    ),
  ).rejects.toThrow();

  expect(await readCompanion(storage, KEY)).toEqual(before as never);
});

test("a purchase applies its own effect to the state", async () => {
  await creditTokens(storage, KEY, ITEM_PRICES.rareCandy, 1);

  await purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({
      applied: { ...s, inventory: { ...s.inventory, rareCandy: s.inventory.rareCandy + 1 } },
    }),
    2,
  );

  expect((await readCompanion(storage, KEY))?.state?.inventory.rareCandy).toBe(1);
});

// ---------------------------------------------------------------- dex

test("the dex fails open: one corrupt row costs its row and nothing else", async () => {
  // The opposite direction from the active companion, deliberately. A trophy
  // case is history — losing one entry is a gap, hiding the rest is worse.
  for (const [i, final] of [3, 6, 9].entries()) {
    await recordGraduation(
      storage,
      KEY,
      {
        baseId: final - 2,
        finalId: final,
        chainOrder: [final - 2, final - 1, final],
        stageTimes: null,
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        caughtAt: 100 + i,
      },
      `dex_${final}`,
    );
  }
  await storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", ["{{{", "dex_6"]);

  const entries = await readDex(storage, KEY);
  expect(entries.map((e) => e.finalId)).toEqual([9, 3]);
});

test("sighting records every stage the live companion has reached, and no more", async () => {
  // `plannedPath.slice(0, stageIndex + 1)` is exactly "what this individual has
  // been". The stages ahead of it are a plan rather than a history, and writing
  // them would put a Venusaur in the collection of somebody holding an Ivysaur.
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [1, 2, 3],
      stageIndex: 1,
      stageTimes: [111, 222],
      rarity: "common",
      isShiny: false,
      disguised: false,
    },
    999,
  );

  expect((await listSightings(storage, KEY)).map((s) => s.speciesId)).toEqual([1, 2]);
});

test("a sighting keeps the instant the stage was entered, not the instant it was written", async () => {
  // Written on every settle, so `now` is whenever the panel last polled — which
  // is not when the companion evolved. Taking it would date every stage to the
  // first poll after this feature shipped.
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [1, 2],
      stageIndex: 1,
      stageTimes: [111, 222],
      rarity: "common",
      isShiny: false,
      disguised: false,
    },
    999,
  );

  expect((await listSightings(storage, KEY)).map((s) => s.seenAt)).toEqual([111, 222]);
});

test("a stage with no recorded instant falls back to the write time", async () => {
  // A companion that hatched before stage instants existed has a shorter
  // `stageTimes` than `plannedPath`. Its stages are still real sightings, so
  // they are recorded — dated from now, which is late but is the only instant
  // anyone has.
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [1, 2],
      stageIndex: 1,
      stageTimes: [],
      rarity: "common",
      isShiny: false,
      disguised: false,
    },
    999,
  );

  expect((await listSightings(storage, KEY)).map((s) => s.seenAt)).toEqual([999, 999]);
});

test("sighting the same stage twice keeps the first instant", async () => {
  // Written on every settle, so the second call is the normal case rather than
  // the exception. First sighting wins and is never updated — the same
  // monotonic rule the growth counters follow.
  const seen = {
    plannedPath: [1, 2],
    stageIndex: 1,
    stageTimes: [111, 222],
    rarity: "common",
    isShiny: false,
    disguised: false,
  };
  await recordSightings(storage, KEY, seen, 999);
  await recordSightings(storage, KEY, { ...seen, stageTimes: [777, 888] }, 5_000);

  expect((await listSightings(storage, KEY)).map((s) => s.seenAt)).toEqual([111, 222]);
});

test("a disguised Ditto sights nothing until it reveals", async () => {
  // The plugin knows it is a Ditto. Recording the disguise would put a species
  // in the collection that was never really there, and the reveal would then
  // have to take it away again.
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [10, 11],
      stageIndex: 0,
      stageTimes: [111],
      rarity: "common",
      isShiny: false,
      disguised: true,
    },
    999,
  );

  expect(await listSightings(storage, KEY)).toEqual([]);
});

test("a sighting carries the line it was on, so the record can draw a chain", async () => {
  // Without this a species seen but never graduated has no evolution line at
  // all — there is no Dex row to take one from — and its record would be a
  // sprite with nothing under it.
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [1, 2, 3],
      stageIndex: 0,
      stageTimes: [111],
      rarity: "uncommon",
      isShiny: true,
      disguised: false,
    },
    999,
  );

  expect((await listSightings(storage, KEY))[0]).toMatchObject({
    speciesId: 1,
    chainOrder: [1, 2, 3],
    rarity: "uncommon",
    isShiny: true,
  });
});

test("one key cannot see another key's sightings", async () => {
  await recordSightings(
    storage,
    "key_other",
    {
      plannedPath: [1],
      stageIndex: 0,
      stageTimes: [111],
      rarity: "common",
      isShiny: false,
      disguised: false,
    },
    999,
  );

  expect(await listSightings(storage, KEY)).toEqual([]);
  expect(await listSightings(storage, "key_other")).toHaveLength(1);
});

test("an unreadable sighting chain costs its row, not the listing", async () => {
  // Fails open like `readDex`, and for the same reason: a collection is
  // history, so losing one entry is a gap and hiding the rest is worse.
  for (const id of [1, 2]) {
    await recordSightings(
      storage,
      KEY,
      {
        plannedPath: [id],
        stageIndex: 0,
        stageTimes: [100 + id],
        rarity: "common",
        isShiny: false,
        disguised: false,
      },
      999,
    );
  }
  await storage.run("UPDATE {{sightings}} SET chain_order = ? WHERE species_id = ?", ["{{{", 1]);

  expect((await listSightings(storage, KEY)).map((s) => s.speciesId)).toEqual([2]);
});

test("the collection read takes both sources, so neither can be forgotten at a call site", async () => {
  // The seam `collect` used to be assembled at, once per caller. Both lists
  // reach it or the collection is quietly short: a caller that read the Dex and
  // forgot the sightings would render a panel missing every species whose
  // individual has not graduated, with nothing to say it had.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: null,
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 1_000_000,
    },
    "dex_3",
  );
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [25, 26],
      stageIndex: 0,
      stageTimes: [2_000_000],
      rarity: "rare",
      isShiny: false,
      disguised: false,
    },
    9_000_000,
  );

  // Pikachu is on no graduation, so it can only have come from the sightings.
  expect((await readCollection(storage, KEY)).map((record) => record.speciesId)).toEqual([
    1, 2, 3, 25,
  ]);
});

test("a graduation stores the instant each stage was entered", async () => {
  // The column migration 6 added, and the reason this feature needed one at
  // all: growth is measured in tokens and no arithmetic over tokens yields a
  // date, so an instant not written here can never be recovered.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [111, 222, 333],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 999,
    },
    "dex_stamped",
  );

  expect((await readDex(storage, KEY))[0]).toMatchObject({
    stageTimes: [111, 222, 333],
    caughtAt: 999,
  });
});

test("a dex row written before stage instants existed reads back with none", async () => {
  // Migration 6 is `ADD COLUMN` with no default, so every row already in the
  // table has SQL NULL here. Null and not `[]`: "never recorded" and "recorded
  // as empty" are different facts, and the panel says so rather than dating an
  // old graduate to an instant nobody observed.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [111, 222, 333],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 999,
    },
    "dex_legacy",
  );
  await storage.run("UPDATE {{dex}} SET stage_times = NULL WHERE id = ?", ["dex_legacy"]);

  expect((await readDex(storage, KEY))[0]?.stageTimes).toBeNull();
});

test("an unreadable stage_times costs the instants, never the row", async () => {
  // Fails open, like every other soft field on this table and unlike the active
  // companion. A trophy case is history: the graduation itself is still a fact
  // worth showing, and losing the row over a decoration would be the trade this
  // table exists to refuse.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [111, 222, 333],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 999,
    },
    "dex_bad_times",
  );
  await storage.run("UPDATE {{dex}} SET stage_times = ? WHERE id = ?", ["{{{", "dex_bad_times"]);

  const row = (await readDex(storage, KEY))[0];
  expect(row?.finalId).toBe(3);
  expect(row?.stageTimes).toBeNull();
});

test("a dex chain that parses but is not a chain is dropped, not returned", async () => {
  // Valid JSON that is not an array of ids. The corrupt-row test above never
  // reaches this branch because its fixture fails at JSON.parse, so without this
  // the isArray check could be deleted and nothing would notice.
  for (const [i, final] of [3, 6].entries()) {
    await recordGraduation(
      storage,
      KEY,
      {
        baseId: final - 2,
        finalId: final,
        chainOrder: [final - 2, final - 1, final],
        stageTimes: null,
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        caughtAt: 100 + i,
      },
      `dex_${final}`,
    );
  }
  await storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", [
    '{"not":"an array"}',
    "dex_6",
  ]);
  expect((await readDex(storage, KEY)).map((e) => e.finalId)).toEqual([3]);

  // And an array with no usable ids in it.
  await storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", ['["a","b"]', "dex_3"]);
  expect(await readDex(storage, KEY)).toEqual([]);
});

test("one key cannot see another key's dex", async () => {
  await recordGraduation(
    storage,
    "key_other",
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: null,
      rarity: "rare",
      isShiny: true,
      nature: "brave",
      caughtAt: 1,
    },
    "dex_other",
  );
  expect(await readDex(storage, KEY)).toEqual([]);
  expect(await readDex(storage, "key_other")).toHaveLength(1);
});

// ---------------------------------------------------------------- grants

test("a grant instant is remembered per key and window", async () => {
  // Persisted rather than held in memory, because in memory a restart re-grants
  // forever. Null for never, so "not yet" and "paid at epoch" stay apart.
  expect(await lastGrantedAt(storage, KEY, "tokens:1w")).toBeNull();
  // Null is the claim on a window nobody has seen, and it wins.
  expect(await claimGrant(storage, KEY, "tokens:1w", null, 5_000)).toBe(true);
  expect(await lastGrantedAt(storage, KEY, "tokens:1w")).toBe(5_000);
  expect(await lastGrantedAt(storage, KEY, "requests:1m")).toBeNull();
  expect(await lastGrantedAt(storage, "key_other", "tokens:1w")).toBeNull();
});

test("a later grant replaces the earlier instant, and a stale one does not", async () => {
  // The compare-and-swap that replaced the unconditional upsert. `previous` is
  // what the caller read before it decided, so exactly one of two replicas
  // holding the same instant can claim the window — the other is told it lost
  // rather than paying a second time for one window.
  expect(await claimGrant(storage, KEY, "tokens:1w", null, 5_000)).toBe(true);
  expect(await claimGrant(storage, KEY, "tokens:1w", 5_000, 9_000)).toBe(true);
  expect(await lastGrantedAt(storage, KEY, "tokens:1w")).toBe(9_000);

  // The replica that read 5,000 and decided a moment later: refused, and the
  // winner's instant is left where it is.
  expect(await claimGrant(storage, KEY, "tokens:1w", 5_000, 12_000)).toBe(false);
  expect(await lastGrantedAt(storage, KEY, "tokens:1w")).toBe(9_000);
});

test("a state written by hand still round-trips", async () => {
  await creditTokens(storage, KEY, 1, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    serialiseState(freshState()),
    KEY,
  ]);
  expect((await readCompanion(storage, KEY))?.state).toEqual(freshState());
});

test("a credit onto an unreadable save never overwrites it", async () => {
  // The single most irreversible thing this plugin can do, and it was untested:
  // the existing coverage credited BEFORE corrupting the row, so adding
  // `state = excluded.state` to the ON CONFLICT would have left the whole suite
  // green while destroying every unreadable save on the next request.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  await creditTokens(storage, KEY, 5_000, 2);

  const raw = await storage.get<{ state: string; tokens_total: number }>(
    "SELECT state, tokens_total FROM {{companion}} WHERE api_key_id = ?",
    [KEY],
  );
  expect(raw?.state).toBe("{ broken");
  // The counter still advances: the tokens were spent whether or not the save
  // can be read, and losing them would compound one problem into two.
  expect(raw?.tokens_total).toBe(6_000);
});

test("a held item is spent from inventory, not from the wallet", async () => {
  // A granted candy was never bought. Charging for it would charge twice.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      ...freshState(),
      inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
    }),
    KEY,
  ]);

  const result = await consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2);
  expect(result.ok).toBe(true);

  const row = await readCompanion(storage, KEY);
  expect(row?.state?.inventory.rareCandy).toBe(1);
  expect(row?.tokensSpent).toBe(0);
});

test("an effect that refuses spends nothing and writes nothing", async () => {
  // The ordering invariant, at the level it actually lives. `consume` used to
  // decrement first and write whatever came back, so an effect that declined to
  // act still cost the item — indistinguishable, from here, from one that ran.
  await creditTokens(storage, KEY, 1_000, 1);
  const before = {
    ...freshState(),
    inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
  };
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify(before),
    KEY,
  ]);

  const result = await consume(storage, KEY, "rareCandy", () => ({ refused: "no-companion" }), 2);

  expect(result).toEqual({ ok: false, reason: "no-companion" });
  expect((await readCompanion(storage, KEY))?.state?.inventory.rareCandy).toBe(2);
});

test("the effect sees the inventory it will be spent from, not one already docked", async () => {
  // The decrement applies to what the effect produced, so an effect that reads
  // its own count sees the truth. Handing it a pre-docked inventory made the
  // count off by one for anything that looked.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      ...freshState(),
      inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
    }),
    KEY,
  ]);

  let seen = -1;
  await consume(
    storage,
    KEY,
    "rareCandy",
    (state) => {
      seen = state.inventory.rareCandy;
      return { applied: state };
    },
    2,
  );

  expect(seen).toBe(2);
  expect((await readCompanion(storage, KEY))?.state?.inventory.rareCandy).toBe(1);
});

test("an item nobody holds cannot be spent", async () => {
  await creditTokens(storage, KEY, 1_000, 1);
  expect(await consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2)).toEqual({
    ok: false,
    reason: "none-held",
  });
});

test("a held item cannot be spent against an unreadable save", async () => {
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["nonsense", KEY]);
  expect(await consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2)).toEqual({
    ok: false,
    reason: "unreadable",
  });
});

// ---------------------------------------------------------------- the roster

test("the roster lists every key that has earned, most recent earner first", async () => {
  // The whole point of the route this backs: an operator has no other place to
  // find the ids of the keys that have companions.
  await creditTokens(storage, "key_old", 1_000, 1_000);
  await creditTokens(storage, "key_new", 1_000, 9_000);
  await creditTokens(storage, "key_mid", 1_000, 5_000);

  expect((await listCompanions(storage)).map((row) => row.apiKeyId)).toEqual([
    "key_new",
    "key_mid",
    "key_old",
  ]);
});

test("a key that has never been observed earning sorts last, however large its total", async () => {
  // `last_credit_at` is null for a row written before migration 5. Sorting it
  // as if it were instant zero would be right; sorting it as if it were *now* —
  // which is what a bare DESC does to NULL in SQLite — puts the least active
  // key at the top of the roster.
  await creditTokens(storage, "key_recent", 10, 5_000);
  await creditTokens(storage, "key_ancient", 10_000_000, 1_000);
  await storage.run("UPDATE {{companion}} SET last_credit_at = NULL WHERE api_key_id = ?", [
    "key_ancient",
  ]);

  expect((await listCompanions(storage)).map((row) => row.apiKeyId)).toEqual([
    "key_recent",
    "key_ancient",
  ]);
});

test("an unreadable save keeps its place in the roster instead of hiding the key", async () => {
  // Fails open, like the Dex and unlike `settle`. A key whose save cannot be
  // read is the one an operator most needs to see listed — dropping it from the
  // roster is how a corrupt companion becomes invisible.
  await creditTokens(storage, KEY, 1_000, 1);
  await storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  const roster = await listCompanions(storage);
  expect(roster).toHaveLength(1);
  expect(roster[0]?.apiKeyId).toBe(KEY);
  expect(roster[0]?.state).toBeNull();
});

test("the roster is empty before any key has earned", async () => {
  expect(await listCompanions(storage)).toEqual([]);
});

test("a graduation with unrecorded stages keeps the instants it does have", async () => {
  // The legacy shape: a companion part-way up its line when instants started
  // being recorded graduates with holes where nobody wrote anything down.
  // Rejecting the whole array over them would throw away the dates that *are*
  // real, and every one of those is unrecoverable.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [null, null, 17_000],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 17_000,
    },
    "dex_holes",
  );

  expect((await readDex(storage, KEY))[0]?.stageTimes).toEqual([null, null, 17_000]);
});

test("a hole dates its species from nothing rather than from a later stage", async () => {
  // The whole point of storing the hole. `enteredAtOf` reads positionally, so a
  // compacted array would hand #1 the instant that belongs to #3 — and the
  // record would state it as a first catch.
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [null, null, 17_000],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      caughtAt: 99_000,
    },
    "dex_holes_2",
  );

  const collection = await readCollection(storage, KEY);
  // #1 was never dated, so it falls back to the graduation and says so.
  expect(collection[0]).toMatchObject({ firstCaughtAt: 99_000, firstCaughtExact: false });
  // #3 has its own instant and is exact.
  expect(collection[2]).toMatchObject({ firstCaughtAt: 17_000, firstCaughtExact: true });
});
