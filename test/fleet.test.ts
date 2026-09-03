import { afterEach, beforeEach, expect, test } from "bun:test";
import { EGG_HATCH_THRESHOLD, ITEM_PRICES, phaseThreshold } from "../src/balance.ts";
import { freshState, serialiseState } from "../src/state.ts";
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

test("the second of two identical writers hears no, and loses nothing by it", async () => {
  // The statement reports itself rather than being inferred from a later read,
  // so the loser is told it did not write — which is true. What it asked for is
  // on the row regardless, put there by the caller that won, so the honest
  // answer costs it nothing. The inferring version said "yes" to both, and paid
  // for that symmetry by also saying "no" to writes that had landed.
  await seed(1_000);
  const a = await readCompanion(storage, KEY);
  const b = await readCompanion(storage, KEY);
  if (a?.state == null || b?.state == null) throw new Error("seeded companion did not read back");

  expect(await writeState(storage, KEY, a.raw, { ...a.state, incense: true }, 10)).toBe(true);
  expect(await writeState(storage, KEY, b.raw, { ...b.state, incense: true }, 11)).toBe(false);

  expect((await readCompanion(storage, KEY))?.state?.incense).toBe(true);
});

test("a swap that landed is never reported as lost, however busy the row", async () => {
  /*
    The failure the read-back version had and this one cannot.

    Inferring the outcome from a later `SELECT` means anybody who writes between
    the `UPDATE` and that read turns a successful swap into `false` — and a
    settle that reports no write files no Dex row for a graduation the row has
    already taken, with nothing able to re-emit it. Here the write is racing a
    second writer that lands immediately after it, which is exactly the window
    that used to lie.
  */
  await seed(1_000);
  const mine = await readCompanion(storage, KEY);
  if (mine?.state == null) throw new Error("no companion");

  const won = await writeState(storage, KEY, mine.raw, { ...mine.state, incense: true }, 10);
  // Somebody else writes the instant afterwards, over what this call just wrote.
  const next = await readCompanion(storage, KEY);
  if (next?.state == null) throw new Error("no companion");
  await writeState(storage, KEY, next.raw, { ...next.state, lure: true }, 11);

  expect(won).toBe(true);
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
  // One debit, one candy, and exactly one caller told the purchase happened. The
  // refusal is honest rather than unfortunate: that caller's own `UPDATE` matched
  // nothing, so it hears `stale` and its wallet was never touched. The version
  // that inferred the outcome from a later read told both of them yes — and, in
  // the window where somebody wrote in between, told the one that *had* debited
  // that it failed.
  expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
  expect([one, two].find((result) => !result.ok)).toEqual({ ok: false, reason: "stale" });
  // The winner answers with the balance the row now holds, taken from the
  // statement that debited it rather than computed from the read before it.
  const winner = [one, two].find((result) => result.ok);
  expect(winner?.ok === true ? wallet(winner.row) : null).toBe(10);
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
  // One caller wrote, one did not, and each is told which. The one refused is
  // told `stale` rather than `none-held`: it read a bag that had the item, so
  // the honest report is that the save moved, not that the item was missing.
  expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
  expect([one, two].find((result) => !result.ok)).toEqual({ ok: false, reason: "stale" });
  // And the effect landed exactly once, from the winner.
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

test("one window pays one replica, and the loser is told so by its own statement", async () => {
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

  // One settle wrote and one did not, and the loser reports the save as it read
  // it — no events, so its caller logs no graduation and pushes no frame for a
  // write it did not make. The winner's growth is on the row either way, and a
  // second helping was never applied: `advance` works from the difference.
  expect([first?.wrote, second?.wrote].filter(Boolean)).toHaveLength(1);
  expect([first, second].find((result) => result?.wrote === false)?.events).toEqual([]);
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
test("two graduations at one token total are two Dex rows, not one", async () => {
  /*
    The trap in deriving an id from `consumedTotal`, which is what this did
    first: that number moves with *traffic*, and growth arrives without any. An
    everstone banks it, a rare candy injects it, and a graduation hands its
    overflow to the next egg — so two graduations can happen at one token total,
    both take index 0 of the same number, and `ON CONFLICT DO NOTHING` swallows
    the second. Silently and unrecoverably: nothing re-emits a graduation whose
    state has already moved.

    Every settle below is zero-gain — no tokens are credited after the seed,
    which is the whole point. The ids must differ anyway.
  */
  const BANK = 5_000_000_000;
  await seed(10_000);
  const start = await readCompanion(storage, KEY);
  if (start?.state == null) throw new Error("no companion");

  // A companion pinned at its final stage while a busy key banked growth into
  // it, with the stone just taken off.
  await writeState(
    storage,
    KEY,
    start.raw,
    {
      ...start.state,
      consumedTotal: start.tokensTotal,
      active: {
        baseId: 132,
        plannedPath: [132],
        stageIndex: 0,
        stageTimes: [1],
        usedAtStage: BANK,
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

  // The banked growth graduates it, and the overflow lands in the next egg.
  const first = await settle(storage, KEY, 100);
  expect(first?.events.map((event) => event.kind)).toEqual(["graduated"]);

  // The panel's prefetch rolls that egg; still no tokens arrive.
  const hatching = await readCompanion(storage, KEY);
  if (hatching?.state == null) throw new Error("no companion");
  await writeState(
    storage,
    KEY,
    hatching.raw,
    {
      ...hatching.state,
      pendingHatch: {
        speciesId: 1,
        path: [1, 2, 3],
        rarity: "common",
        isShiny: false,
        nature: "hardy",
        ditto: false,
      },
    },
    110,
  );

  // The same overflow carries the new line all the way out, at the same total.
  const second = await settle(storage, KEY, 120);
  expect(second?.events.map((event) => event.kind)).toEqual([
    "hatched",
    "evolved",
    "evolved",
    "graduated",
  ]);

  const dex = await readDex(storage, KEY);
  expect(dex.map((entry) => entry.finalId).sort((a, b) => a - b)).toEqual([3, 132]);
});

// ------------------------------------------------------------------- dialect

test("a BIGINT column arriving as a string is still a number by the time it is read", async () => {
  /*
    Bun's Postgres driver hands a 64-bit column back as a **string** rather than
    narrowing it into a double on its own; `bun:sqlite` hands back a number. Every
    instant and every accumulating counter this plugin stores is `BIGINT` — an
    epoch millisecond does not fit in `int4` and neither does a shiny charm — so
    on a clustered install every one of them arrives as text.

    Nothing else here can catch that: SQLite is the only backend these suites run
    against, and it is the one that does not do it. So the driver is imitated —
    but only for the columns that are actually `BIGINT`. Stringifying *every*
    number would be a worse imitation than none: `is_shiny` and the species ids
    are `INTEGER`, Postgres narrows those to numbers, and a wrapper that turned
    them into strings would fail `is_shiny === 1` for a reason no backend has.
  */
  await seed(4_000);
  await claimGrant(storage, KEY, "tokens:1w", null, 12_345_678_901);
  const seeded = await readCompanion(storage, KEY);
  if (seeded?.state == null) throw new Error("no companion");
  await recordGraduation(
    storage,
    KEY,
    {
      baseId: 1,
      finalId: 3,
      chainOrder: [1, 2, 3],
      stageTimes: [1, 2, 3],
      rarity: "common",
      isShiny: true,
      nature: "hardy",
      caughtAt: 9_876_543_210,
    },
    "dex-1",
  );
  await recordSightings(
    storage,
    KEY,
    {
      plannedPath: [1],
      stageIndex: 0,
      stageTimes: [8_765_432_109],
      rarity: "common",
      isShiny: true,
      disguised: false,
    },
    1,
  );

  const asPostgres: typeof storage = {
    ...storage,
    get: async <T>(sql: string, params?: readonly unknown[]) =>
      widen(await storage.get<T>(sql, params)) as T | null,
    all: async <T>(sql: string, params?: readonly unknown[]) =>
      (await storage.all<T>(sql, params)).map((row) => widen(row) as T),
  };

  const row = await readCompanion(asPostgres, KEY);
  expect(row?.tokensTotal).toBe(4_000);
  expect(row?.lastCreditAt).toBe(1);
  // The arithmetic, not just the shape: a string here concatenates instead of
  // subtracting, and a wallet renders as nonsense rather than as an error.
  expect(wallet(row as NonNullable<typeof row>)).toBe(4_000);

  expect((await listCompanions(asPostgres))[0]?.tokensTotal).toBe(4_000);
  expect(await lastGrantedAt(asPostgres, KEY, "tokens:1w")).toBe(12_345_678_901);

  const dex = await readDex(asPostgres, KEY);
  expect(dex[0]?.caughtAt).toBe(9_876_543_210);
  // The `INTEGER` columns beside it still read as themselves.
  expect(dex[0]?.isShiny).toBe(true);
  expect(dex[0]?.finalId).toBe(3);

  const sightings = await listSightings(asPostgres, KEY);
  expect(sightings[0]?.seenAt).toBe(8_765_432_109);
  expect(sightings[0]?.speciesId).toBe(1);
  expect(sightings[0]?.isShiny).toBe(true);
});

/**
 * A row as the Postgres driver would hand it back: `BIGINT` columns as strings,
 * everything else unchanged.
 *
 * Named per column rather than by type, because that is how the driver decides
 * — `int8` becomes a string, `int4` does not — and a wrapper that guessed from
 * the JavaScript type would model neither backend.
 */
const BIGINT_COLUMNS = new Set([
  "tokens_total",
  "tokens_spent",
  "created_at",
  "updated_at",
  "last_credit_at",
  "caught_at",
  "granted_at",
  "seen_at",
]);

function widen(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key,
      BIGINT_COLUMNS.has(key) && typeof value === "number" ? String(value) : value,
    ]),
  );
}
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
