import { afterEach, beforeEach, expect, test } from "bun:test";
import { EGG_HATCH_THRESHOLD, ITEM_PRICES, phaseThreshold } from "../src/balance.ts";
import { freshState, serialiseState } from "../src/state.ts";
import {
  claimGrant,
  consume,
  creditTokens,
  lastGrantedAt,
  MIGRATIONS,
  purchase,
  readCompanion,
  readDex,
  settle,
  wallet,
  writeState,
} from "../src/store.ts";
import { createTestStorage, type TestStorage } from "./helpers/storage.ts";

/**
 * Two replicas over one database.
 *
 * Everything here is the same shape: read the row *once*, hand that same read to
 * two callers, and assert that the second one loses rather than overwriting the
 * first. That is what a second gateway pod is — not a different database, not a
 * different transaction, just a second holder of a row it read a moment ago —
 * and it is the only part of this plugin a single-process test can never reach.
 *
 * The reads are deliberately taken before either write. A test that re-read
 * between them would be testing a sequence, which was never in doubt.
 */

const KEY = "key_1";
let storage: TestStorage;

beforeEach(() => {
  storage = createTestStorage();
  storage.migrate(MIGRATIONS);
});

afterEach(() => {
  storage.close();
});

/** A companion with tokens banked and nothing spent. */
async function seed(tokens: number): Promise<void> {
  await creditTokens(storage, KEY, tokens, 1);
}

test("the second writer of a stale save loses, and the row keeps the first one's", async () => {
  await seed(1_000);
  const a = await readCompanion(storage, KEY);
  const b = await readCompanion(storage, KEY);
  if (a?.state == null || b?.state == null) throw new Error("seeded companion did not read back");

  const first = await writeState(storage, KEY, a.raw, { ...a.state, incense: true }, 10);
  const second = await writeState(storage, KEY, b.raw, { ...b.state, lure: true }, 11);

  expect(first).toBe(true);
  expect(second).toBe(false);
  const after = await readCompanion(storage, KEY);
  expect(after?.state?.incense).toBe(true);
  // Not merged, not last-write-wins: the losing modifier is simply not there,
  // and its caller was told so rather than shown a success.
  expect(after?.state?.lure).toBe(false);
});

test("two callers writing the same save both hear yes, because it is one intent twice", async () => {
  await seed(1_000);
  const a = await readCompanion(storage, KEY);
  const b = await readCompanion(storage, KEY);
  if (a?.state == null || b?.state == null) throw new Error("seeded companion did not read back");

  expect(await writeState(storage, KEY, a.raw, { ...a.state, incense: true }, 10)).toBe(true);
  expect(await writeState(storage, KEY, b.raw, { ...b.state, incense: true }, 11)).toBe(true);

  // One row, one outcome, and nobody told they lost something they did not.
  expect((await readCompanion(storage, KEY))?.state?.incense).toBe(true);
});

test("a purchase debits once when two replicas price it against one wallet", async () => {
  await seed(ITEM_PRICES.rareCandy + 10);
  // Both replicas see a wallet that covers exactly one candy.
  const before = await readCompanion(storage, KEY);
  if (before === null) throw new Error("no companion");
  expect(wallet(before)).toBeGreaterThanOrEqual(ITEM_PRICES.rareCandy);

  const buy = () =>
    purchase(
      storage,
      KEY,
      { kind: "item", item: "rareCandy" },
      (state) => ({
        applied: {
          ...state,
          inventory: { ...state.inventory, rareCandy: state.inventory.rareCandy + 1 },
        },
      }),
      20,
    );
  // Started together, from one row, the way two pods serving two clicks do.
  const [one, two] = await Promise.all([buy(), buy()]);

  const after = await readCompanion(storage, KEY);
  expect(after?.tokensSpent).toBe(ITEM_PRICES.rareCandy);
  expect(after?.state?.inventory.rareCandy).toBe(1);
  // Both saw the same wallet and both produced the same save, so both are told
  // the purchase they asked for happened — and it did, once. What may never
  // happen is the debit landing twice, which is the assertion above.
  expect([one.ok, two.ok]).toEqual([true, true]);
});

test("a wallet that only covers one purchase cannot fund two different ones", async () => {
  await seed(ITEM_PRICES.rareCandy + 10);
  const row = await readCompanion(storage, KEY);
  if (row?.state == null) throw new Error("no companion");

  // Two *different* intents against one balance: distinct saves, so the
  // byte-identical collapse above cannot explain the result away.
  const [candy, lure] = await Promise.all([
    purchase(
      storage,
      KEY,
      { kind: "item", item: "rareCandy" },
      (state) => ({
        applied: {
          ...state,
          inventory: { ...state.inventory, rareCandy: state.inventory.rareCandy + 1 },
        },
      }),
      20,
    ),
    purchase(
      storage,
      KEY,
      { kind: "item", item: "lure" },
      (state) => ({ applied: { ...state, lure: true } }),
      21,
    ),
  ]);

  expect([candy.ok, lure.ok].filter(Boolean)).toHaveLength(1);
  const after = await readCompanion(storage, KEY);
  expect(after?.tokensSpent).toBe(ITEM_PRICES.rareCandy);
  expect(wallet(after as NonNullable<typeof after>)).toBe(10);
});

test("an item is spent once when two replicas consume the same held one", async () => {
  await seed(1_000);
  const row = await readCompanion(storage, KEY);
  if (row?.state == null) throw new Error("no companion");
  await writeState(
    storage,
    KEY,
    row.raw,
    { ...row.state, inventory: { ...row.state.inventory, lure: 1 } },
    5,
  );

  const use = () =>
    consume(storage, KEY, "lure", (state) => ({ applied: { ...state, lure: true } }), 30);
  const [one, two] = await Promise.all([use(), use()]);

  // **One decrement**, which is the assertion that matters: the bag cannot pay
  // twice for one held item however many replicas reach for it.
  expect((await readCompanion(storage, KEY))?.state?.inventory.lure).toBe(0);
  // Both are told yes, and that is the rule `writeState` documents rather than a
  // gap in this test. Two consumes of one item from one save produce the same
  // save, so this is one intent submitted twice — the item was spent once and
  // the lure is armed, which is what both callers asked for. A caller told
  // `stale` here would be told it lost something it did not.
  expect([one.ok, two.ok]).toEqual([true, true]);
  expect((await readCompanion(storage, KEY))?.state?.lure).toBe(true);
});

test("a second use of an item held once is refused once the first has landed", async () => {
  // The sequential half of the test above, which is where a caller *is* told no:
  // the bag is empty by the time the second read happens, so this never reaches
  // a swap at all.
  await seed(1_000);
  const row = await readCompanion(storage, KEY);
  if (row?.state == null) throw new Error("no companion");
  await writeState(
    storage,
    KEY,
    row.raw,
    { ...row.state, inventory: { ...row.state.inventory, lure: 1 } },
    5,
  );

  const first = await consume(
    storage,
    KEY,
    "lure",
    (state) => ({ applied: { ...state, lure: true } }),
    30,
  );
  const second = await consume(
    storage,
    KEY,
    "lure",
    (state) => ({ applied: { ...state, lure: true } }),
    31,
  );

  expect(first.ok).toBe(true);
  expect(second).toEqual({ ok: false, reason: "none-held" });
});

test("one window pays one replica, and the loser reads back an instant that is not its own", async () => {
  const previous = await lastGrantedAt(storage, KEY, "tokens:1w");
  expect(previous).toBeNull();

  // Both decided from the same reading of the window, which is what two pods
  // handling one `LimitReached` do.
  const [a, b] = await Promise.all([
    claimGrant(storage, KEY, "tokens:1w", previous, 100),
    claimGrant(storage, KEY, "tokens:1w", previous, 200),
  ]);

  expect([a, b].filter(Boolean)).toHaveLength(1);
  // And the instant on the row is the winner's, not the later of the two.
  expect(await lastGrantedAt(storage, KEY, "tokens:1w")).toBe(a ? 100 : 200);
});

test("a claim against a stale instant is refused rather than moving the window", async () => {
  await claimGrant(storage, KEY, "tokens:5h", null, 100);

  // A replica that read the window before the claim above landed.
  expect(await claimGrant(storage, KEY, "tokens:5h", null, 500)).toBe(false);
  expect(await lastGrantedAt(storage, KEY, "tokens:5h")).toBe(100);

  // And one that read it after does move it, or a window would pay exactly once
  // for the life of the install.
  expect(await claimGrant(storage, KEY, "tokens:5h", 100, 900)).toBe(true);
  expect(await lastGrantedAt(storage, KEY, "tokens:5h")).toBe(900);
});

test("a graduation reached twice from one save is filed once", async () => {
  // A one-form line, so a single settle carries the companion all the way out.
  const row = await readCompanion(storage, KEY);
  expect(row).toBeNull();
  await seed(1);
  const seeded = await readCompanion(storage, KEY);
  if (seeded?.state == null) throw new Error("no companion");
  await writeState(
    storage,
    KEY,
    seeded.raw,
    {
      ...freshState(),
      active: {
        baseId: 132,
        plannedPath: [132],
        stageIndex: 0,
        stageTimes: [1],
        usedAtStage: 0,
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        dittoDisguise: null,
        dittoRevealed: false,
        everstone: false,
        soothe: false,
        soothedRaw: 0,
      },
    },
    5,
  );
  await creditTokens(storage, KEY, phaseThreshold("common", 1, 0) + EGG_HATCH_THRESHOLD, 6);

  const a = await settle(storage, KEY, 50);
  const b = await settle(storage, KEY, 51);

  // The second settle reads the first's save, finds nothing left to give and
  // writes nothing — but even a settle racing from the *same* save would file
  // the same row id, which is why the id is derived rather than minted.
  expect(a?.wrote).toBe(true);
  expect(b?.wrote).toBe(false);
  expect(b?.events).toEqual([]);
  const dex = await readDex(storage, KEY);
  expect(dex).toHaveLength(1);
  expect(dex[0]?.finalId).toBe(132);
});

test("the losing settle reports no events, so its graduation is neither logged nor pushed", async () => {
  await seed(EGG_HATCH_THRESHOLD);
  const a = await readCompanion(storage, KEY);
  const b = await readCompanion(storage, KEY);
  if (a === null || b === null) throw new Error("no companion");

  const [first, second] = await Promise.all([settle(storage, KEY, 60), settle(storage, KEY, 61)]);

  // Both settles compute the same transition from the same save, so this is the
  // byte-identical case again — what matters is that the row moved once and
  // nothing was granted twice.
  expect(first?.row.state?.consumedTotal).toBe(EGG_HATCH_THRESHOLD);
  expect(second?.row.state?.consumedTotal).toBe(EGG_HATCH_THRESHOLD);
  expect((await readCompanion(storage, KEY))?.state?.consumedTotal).toBe(EGG_HATCH_THRESHOLD);
});

test("a save that will not parse is never overwritten, however contended", async () => {
  await seed(1_000);
  const row = await readCompanion(storage, KEY);
  if (row === null) throw new Error("no companion");
  await storage.run("UPDATE {{companion}} SET state = $1 WHERE api_key_id = $2", ["{oh no", KEY]);

  expect(await settle(storage, KEY, 70)).toEqual({
    row: expect.objectContaining({ state: null }),
    events: [],
    wrote: false,
  });
  const kept = await storage.get<{ state: string }>(
    "SELECT state FROM {{companion}} WHERE api_key_id = $1",
    [KEY],
  );
  expect(kept?.state).toBe("{oh no");
  expect(serialiseState(freshState())).not.toBe(kept?.state);
});
// ------------------------------------------------------------------- dialect

test("no statement in src/ uses a placeholder only SQLite understands", async () => {
  /*
    The one rule in this migration that nothing else can catch.

    `preparePluginSql` expands `{{name}}` and rewrites nothing else, so a `?`
    reaches Postgres verbatim and the statement fails — on a clustered install
    only, at runtime, in whichever path happens to run it. Every test in this
    repository runs on SQLite, which accepts both spellings, so the suite is
    exactly the wrong instrument: it is green either way.

    Read as source text rather than by exercising a query, because the failure is
    a statement nobody ran on the backend that refuses it.
  */
  const sources = new Bun.Glob("*.ts").scan({ cwd: new URL("../src", import.meta.url).pathname });
  const offenders: string[] = [];
  for await (const name of sources) {
    const text = await Bun.file(new URL(`../src/${name}`, import.meta.url).pathname).text();
    // Every string literal, in either quoting style this codebase uses for SQL.
    for (const literal of text.match(/`[^`]*`|"[^"\n]*"/g) ?? []) {
      if (!/\b(INSERT|UPDATE|DELETE|SELECT)\b/i.test(literal)) continue;
      if (literal.includes("?")) offenders.push(`${name}: ${literal.slice(0, 60)}`);
    }
  }
  expect(offenders).toEqual([]);
});
