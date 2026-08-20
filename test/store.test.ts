import { afterEach, beforeEach, expect, test } from "bun:test";
import { EGG_HATCH_THRESHOLD, ITEM_PRICES } from "../src/balance.ts";
import { emptyInventory, freshState, serialiseState } from "../src/state.ts";
import {
  consume,
  creditTokens,
  lastGrantedAt,
  listCompanions,
  MIGRATIONS,
  purchase,
  readCompanion,
  readDex,
  recordGraduation,
  setGrantedAt,
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
  ]);
});

test("a companion appears on first credit, not when a key is minted", () => {
  // Measured from install forward. A key that has never been used has nothing
  // to show and nothing worth a row.
  expect(readCompanion(storage, KEY)).toBeNull();

  creditTokens(storage, KEY, 1_000, 1);
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_000);
});

test("credits accumulate and never decrease", () => {
  creditTokens(storage, KEY, 1_000, 1);
  creditTokens(storage, KEY, 2_500, 2);
  creditTokens(storage, KEY, 0, 3);
  creditTokens(storage, KEY, -5_000, 4);

  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(3_500);
});

test("a zero-token request writes no row and stamps no credit instant", () => {
  // `tokens <= 0`, not `tokens < 0`, and the difference is a whole companion.
  // The accumulation test above credits 0 and asserts a total of 3,500 — which
  // is the same number whether or not the row was written — so the guard's
  // boundary was uncovered from both directions.
  //
  // A request that produced no tokens (a refusal, an empty completion) would
  // otherwise mint a companion for a key that has never earned anything and
  // stamp `last_credit_at` on it: the "working-looking companion" migration 5
  // exists to avoid, arriving through the one site allowed to write that column.
  creditTokens(storage, KEY, 0, 111);
  expect(readCompanion(storage, KEY)).toBeNull();
  expect(storage.get<{ n: number }>("SELECT COUNT(*) AS n FROM {{companion}}", [])?.n).toBe(0);

  // And against a row that does exist it moves neither the meter nor the instant.
  creditTokens(storage, KEY, 4_000, 222);
  creditTokens(storage, KEY, 0, 333);

  const row = readCompanion(storage, KEY);
  expect(row?.tokensTotal).toBe(4_000);
  expect(row?.lastCreditAt).toBe(222);
});

test("settling twice does not grow twice", () => {
  creditTokens(storage, KEY, EGG_HATCH_THRESHOLD, 1);
  const first = settle(storage, KEY, 2);
  const second = settle(storage, KEY, 3);

  expect(second?.row.state).toEqual(first?.row.state as never);
  expect(second?.events).toEqual([]);
});

test("an unreadable save is left alone rather than replaced", () => {
  // The one irreversible thing this plugin could do to months of growth, and
  // it would do it silently.
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  const result = settle(storage, KEY, 2);
  expect(result?.row.state).toBeNull();
  expect(result?.events).toEqual([]);

  const raw = storage.get<{ state: string }>(
    "SELECT state FROM {{companion}} WHERE api_key_id = ?",
    [KEY],
  );
  expect(raw?.state).toBe("{ broken");
});

// ---------------------------------------------------------------- wallet

test("a purchase spends the wallet and never the growth meter", () => {
  creditTokens(storage, KEY, ITEM_PRICES.rareCandy * 2, 1);

  const result = purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  expect(result.ok).toBe(true);

  const row = readCompanion(storage, KEY);
  expect(row).not.toBeNull();
  if (row === null) return;
  expect(row.tokensTotal).toBe(ITEM_PRICES.rareCandy * 2);
  expect(row.tokensSpent).toBe(ITEM_PRICES.rareCandy);
  expect(wallet(row)).toBe(ITEM_PRICES.rareCandy);
});

test("a second purchase beyond the balance is refused", () => {
  // Named for what it proves. It does NOT demonstrate a race: bun:sqlite is
  // synchronous and this process single-threaded, so a check-then-write cannot
  // interleave and a sequential test cannot show that it can. Removing the
  // transaction leaves this test green, which is how the overstated version of
  // this name was caught.
  creditTokens(storage, KEY, ITEM_PRICES.rareCandy, 1);

  const first = purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  const second = purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    3,
  );

  expect(first.ok).toBe(true);
  expect(second).toEqual({ ok: false, reason: "insufficient" });
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(ITEM_PRICES.rareCandy);
});

test("a purchase that cannot afford itself changes nothing at all", () => {
  creditTokens(storage, KEY, 10, 1);
  const before = readCompanion(storage, KEY);

  const result = purchase(
    storage,
    KEY,
    { kind: "item", item: "shinyCharm" },
    (s) => ({ applied: s }),
    2,
  );

  expect(result).toEqual({ ok: false, reason: "insufficient" });
  expect(readCompanion(storage, KEY)).toEqual(before as never);
});

test("a purchase against an unreadable save is refused, not attempted", () => {
  creditTokens(storage, KEY, ITEM_PRICES.shinyCharm, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["nonsense", KEY]);

  const result = purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({ applied: s }),
    2,
  );
  expect(result).toEqual({ ok: false, reason: "unreadable" });
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(0);
});

test("a purchase whose effect throws debits nothing and stores nothing", () => {
  // Holds because `applyToState` runs before any write, not because of a
  // transaction — there was one here and it could not be killed by any test,
  // so it was removed as decoration. This pins the ordering that makes it true.
  creditTokens(storage, KEY, ITEM_PRICES.rareCandy * 2, 1);
  const before = readCompanion(storage, KEY);

  expect(() =>
    purchase(
      storage,
      KEY,
      { kind: "item", item: "rareCandy" },
      () => {
        throw new Error("effect failed");
      },
      2,
    ),
  ).toThrow();

  expect(readCompanion(storage, KEY)).toEqual(before as never);
});

test("a purchase applies its own effect to the state", () => {
  creditTokens(storage, KEY, ITEM_PRICES.rareCandy, 1);

  purchase(
    storage,
    KEY,
    { kind: "item", item: "rareCandy" },
    (s) => ({
      applied: { ...s, inventory: { ...s.inventory, rareCandy: s.inventory.rareCandy + 1 } },
    }),
    2,
  );

  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(1);
});

// ---------------------------------------------------------------- dex

test("the dex fails open: one corrupt row costs its row and nothing else", () => {
  // The opposite direction from the active companion, deliberately. A trophy
  // case is history — losing one entry is a gap, hiding the rest is worse.
  for (const [i, final] of [3, 6, 9].entries()) {
    recordGraduation(
      storage,
      KEY,
      {
        baseId: final - 2,
        finalId: final,
        chainOrder: [final - 2, final - 1, final],
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        caughtAt: 100 + i,
      },
      `dex_${final}`,
    );
  }
  storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", ["{{{", "dex_6"]);

  const entries = readDex(storage, KEY);
  expect(entries.map((e) => e.finalId)).toEqual([9, 3]);
});

test("a dex chain that parses but is not a chain is dropped, not returned", () => {
  // Valid JSON that is not an array of ids. The corrupt-row test above never
  // reaches this branch because its fixture fails at JSON.parse, so without this
  // the isArray check could be deleted and nothing would notice.
  for (const [i, final] of [3, 6].entries()) {
    recordGraduation(
      storage,
      KEY,
      {
        baseId: final - 2,
        finalId: final,
        chainOrder: [final - 2, final - 1, final],
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        caughtAt: 100 + i,
      },
      `dex_${final}`,
    );
  }
  storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", ['{"not":"an array"}', "dex_6"]);
  expect(readDex(storage, KEY).map((e) => e.finalId)).toEqual([3]);

  // And an array with no usable ids in it.
  storage.run("UPDATE {{dex}} SET chain_order = ? WHERE id = ?", ['["a","b"]', "dex_3"]);
  expect(readDex(storage, KEY)).toEqual([]);
});

test("one key cannot see another key's dex", () => {
  recordGraduation(
    storage,
    "key_other",
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      rarity: "rare",
      isShiny: true,
      nature: "brave",
      caughtAt: 1,
    },
    "dex_other",
  );
  expect(readDex(storage, KEY)).toEqual([]);
  expect(readDex(storage, "key_other")).toHaveLength(1);
});

// ---------------------------------------------------------------- grants

test("a grant instant is remembered per key and window", () => {
  // Persisted rather than held in memory, because in memory a restart re-grants
  // forever. Null for never, so "not yet" and "paid at epoch" stay apart.
  expect(lastGrantedAt(storage, KEY, "tokens:1w")).toBeNull();
  setGrantedAt(storage, KEY, "tokens:1w", 5_000);
  expect(lastGrantedAt(storage, KEY, "tokens:1w")).toBe(5_000);
  expect(lastGrantedAt(storage, KEY, "requests:1m")).toBeNull();
  expect(lastGrantedAt(storage, "key_other", "tokens:1w")).toBeNull();
});

test("a later grant replaces the earlier instant", () => {
  setGrantedAt(storage, KEY, "tokens:1w", 5_000);
  setGrantedAt(storage, KEY, "tokens:1w", 9_000);
  expect(lastGrantedAt(storage, KEY, "tokens:1w")).toBe(9_000);
});

test("a state written by hand still round-trips", () => {
  creditTokens(storage, KEY, 1, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    serialiseState(freshState()),
    KEY,
  ]);
  expect(readCompanion(storage, KEY)?.state).toEqual(freshState());
});

test("a credit onto an unreadable save never overwrites it", () => {
  // The single most irreversible thing this plugin can do, and it was untested:
  // the existing coverage credited BEFORE corrupting the row, so adding
  // `state = excluded.state` to the ON CONFLICT would have left the whole suite
  // green while destroying every unreadable save on the next request.
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  creditTokens(storage, KEY, 5_000, 2);

  const raw = storage.get<{ state: string; tokens_total: number }>(
    "SELECT state, tokens_total FROM {{companion}} WHERE api_key_id = ?",
    [KEY],
  );
  expect(raw?.state).toBe("{ broken");
  // The counter still advances: the tokens were spent whether or not the save
  // can be read, and losing them would compound one problem into two.
  expect(raw?.tokens_total).toBe(6_000);
});

test("a held item is spent from inventory, not from the wallet", () => {
  // A granted candy was never bought. Charging for it would charge twice.
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      ...freshState(),
      inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
    }),
    KEY,
  ]);

  const result = consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2);
  expect(result.ok).toBe(true);

  const row = readCompanion(storage, KEY);
  expect(row?.state?.inventory.rareCandy).toBe(1);
  expect(row?.tokensSpent).toBe(0);
});

test("an effect that refuses spends nothing and writes nothing", () => {
  // The ordering invariant, at the level it actually lives. `consume` used to
  // decrement first and write whatever came back, so an effect that declined to
  // act still cost the item — indistinguishable, from here, from one that ran.
  creditTokens(storage, KEY, 1_000, 1);
  const before = {
    ...freshState(),
    inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
  };
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify(before),
    KEY,
  ]);

  const result = consume(storage, KEY, "rareCandy", () => ({ refused: "no-companion" }), 2);

  expect(result).toEqual({ ok: false, reason: "no-companion" });
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(2);
});

test("the effect sees the inventory it will be spent from, not one already docked", () => {
  // The decrement applies to what the effect produced, so an effect that reads
  // its own count sees the truth. Handing it a pre-docked inventory made the
  // count off by one for anything that looked.
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      ...freshState(),
      inventory: { ...emptyInventory(), rareCandy: 2, mint: 0, shinyCharm: 0 },
    }),
    KEY,
  ]);

  let seen = -1;
  consume(
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
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(1);
});

test("an item nobody holds cannot be spent", () => {
  creditTokens(storage, KEY, 1_000, 1);
  expect(consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2)).toEqual({
    ok: false,
    reason: "none-held",
  });
});

test("a held item cannot be spent against an unreadable save", () => {
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["nonsense", KEY]);
  expect(consume(storage, KEY, "rareCandy", (s) => ({ applied: s }), 2)).toEqual({
    ok: false,
    reason: "unreadable",
  });
});

// ---------------------------------------------------------------- the roster

test("the roster lists every key that has earned, most recent earner first", () => {
  // The whole point of the route this backs: an operator has no other place to
  // find the ids of the keys that have companions.
  creditTokens(storage, "key_old", 1_000, 1_000);
  creditTokens(storage, "key_new", 1_000, 9_000);
  creditTokens(storage, "key_mid", 1_000, 5_000);

  expect(listCompanions(storage).map((row) => row.apiKeyId)).toEqual([
    "key_new",
    "key_mid",
    "key_old",
  ]);
});

test("a key that has never been observed earning sorts last, however large its total", () => {
  // `last_credit_at` is null for a row written before migration 5. Sorting it
  // as if it were instant zero would be right; sorting it as if it were *now* —
  // which is what a bare DESC does to NULL in SQLite — puts the least active
  // key at the top of the roster.
  creditTokens(storage, "key_recent", 10, 5_000);
  creditTokens(storage, "key_ancient", 10_000_000, 1_000);
  storage.run("UPDATE {{companion}} SET last_credit_at = NULL WHERE api_key_id = ?", [
    "key_ancient",
  ]);

  expect(listCompanions(storage).map((row) => row.apiKeyId)).toEqual(["key_recent", "key_ancient"]);
});

test("an unreadable save keeps its place in the roster instead of hiding the key", () => {
  // Fails open, like the Dex and unlike `settle`. A key whose save cannot be
  // read is the one an operator most needs to see listed — dropping it from the
  // roster is how a corrupt companion becomes invisible.
  creditTokens(storage, KEY, 1_000, 1);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  const roster = listCompanions(storage);
  expect(roster).toHaveLength(1);
  expect(roster[0]?.apiKeyId).toBe(KEY);
  expect(roster[0]?.state).toBeNull();
});

test("the roster is empty before any key has earned", () => {
  expect(listCompanions(storage)).toEqual([]);
});
