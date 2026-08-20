import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LimitReached,
  PluginFetch,
  PluginFiles,
  RequestCompleted,
} from "@omnigateway/plugin-api";
import type { PluginContext, PluginRoute } from "@omnigateway/plugin-api/define";
import { WINDOW_MS } from "@omnigateway/plugin-api/events";
import { DASHBOARD_SDK_VERSION, PLUGIN_API_VERSION } from "@omnigateway/plugin-api/version";
import {
  EGG_HATCH_THRESHOLD,
  freshEggPrice,
  graduationTotal,
  ITEM_KINDS,
  ITEM_PRICES,
} from "../src/balance.ts";
import companion from "../src/server.ts";
import { emptyInventory, freshState, serialiseState } from "../src/state.ts";
import { readCompanion, readDex, recordGraduation } from "../src/store.ts";
import { createTestStorage, type TestStorage } from "./helpers/storage.ts";

/**
 * The loop as the gateway drives it: the plugin's own `setup`, its own
 * migrations, SQLite, and real events.
 *
 * Every other test in this package exercises one piece. This is the one that
 * would notice if the pieces stopped fitting — a credit that never reaches the
 * state machine, a graduation that never reaches the Dex, an event handler
 * subscribed to the wrong thing.
 *
 * The storage seam is `helpers/storage.ts` rather than the gateway's own store:
 * `@omni/store` is internal and unpublished, so nothing an external plugin can
 * install runs its SQL for it. Two cases that lived here in the monorepo were
 * dropped with the seam, because they asserted the *host's* behaviour and not
 * this companion's, and are covered in the monorepo against the real store
 * instead of being reimplemented here:
 *
 * - that the host records a plugin's migrations and reports the failed one
 *   (`migrate(...).failed`);
 * - that the loader mounts what `setup` returns.
 *
 * What remains is what a third-party author can actually verify: that this
 * plugin's own migrations, routes and handlers do what they claim.
 */

/** Plain, guaranteed-uncommon and guaranteed-rare: the three the shop lists. */
const EGG_TIERS_ON_SALE = 3;

const KEY = "key_1";
let storage: TestStorage;
let onRequest: ((event: RequestCompleted) => void) | null = null;
let onLimit: ((event: LimitReached) => void) | null = null;
let routes: readonly PluginRoute[] = [];
let logged: Array<{ message: string; event?: string | undefined }> = [];
let clock = 1_700_000_000_000;

function completed(over: Partial<RequestCompleted> = {}): RequestCompleted {
  return {
    requestId: "req_1",
    apiKeyId: KEY,
    provider: "anthropic",
    model: "claude-opus-5",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    durationMs: 10,
    ok: true,
    at: 1_000,
    ...over,
  };
}

/** Credits a flat number of tokens through the event path, as a request would. */
function spend(tokens: number, requestId = `req_${Math.trunc(tokens)}`): void {
  onRequest?.(
    completed({ requestId, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
}

/**
 * Writes a companion's state directly, as an earlier session or the panel's own
 * prefetch would have left it.
 *
 * `consumedTotal` is the caller's to set and must match what has been credited,
 * or the next `advance` walks the difference and the fixture stops being the
 * thing under test.
 */
function plant(state: Record<string, unknown>): void {
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify(state),
    KEY,
  ]);
}

/**
 * The species index and one species' detail, already cached on disk.
 *
 * Everything `prefetchHatch` needs with `net` stubbed to throw, which is the
 * whole point of the cache: a roll needs no network at the moment it happens,
 * and a test that reached one would be testing PokéAPI rather than this plugin.
 *
 * One candidate, so the species a roll produces is not in question and the only
 * thing a fixture can change is the rest of the roll.
 */
type CachedSpecies = { id: number; captureRate: number; forms: number; finalId: number };

/** The one common species every test that does not care about rarity uses. */
const COMMON_SPECIES: CachedSpecies = { id: 10, captureRate: 255, forms: 3, finalId: 12 };

function cachedSpecies(species: readonly CachedSpecies[] = [COMMON_SPECIES]): Capabilities {
  const encoder = new TextEncoder();
  const store = new Map<string, Uint8Array>([
    ["species/index.json", encoder.encode(JSON.stringify(species))],
    ...species.map((one): [string, Uint8Array] => [
      `species/${one.id}.json`,
      encoder.encode(
        JSON.stringify({
          captureRate: one.captureRate,
          isLegendary: false,
          isMythical: false,
          chain: Array.from({ length: one.forms }, (_unused, step) => one.id + step),
          names: [{ language: { name: "en" }, name: `species-${one.id}` }],
        }),
      ),
    ]),
  ]);

  return {
    files: {
      read: async (path) => store.get(path) ?? null,
      write: async (path, data) => {
        store.set(path, data);
      },
      exists: async (path) => store.has(path),
    },
    net: async (url) => {
      throw new Error(`the cache should have answered ${url}`);
    },
  };
}

/**
 * A cold cache with the network reachable, which is exactly what a restore
 * leaves behind: `data/` is excluded from database snapshots, so every species
 * document a hatched companion's name came from is gone while PokéAPI is still
 * there. `calls` is asserted rather than ignored — the whole risk in warming a
 * name is that it becomes a crawl.
 */
function coldCacheOnline(
  options: {
    /** Species PokéAPI answers 404 for, which is a permanent failure and not an outage. */
    missing?: readonly number[];
    /** Which evolution chain a species belongs to. Its own, unless a test shares one. */
    chainOf?: (id: number) => number;
  } = {},
): Capabilities & { calls: string[] } {
  const store = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const missing = new Set(options.missing ?? []);
  const chainOf = options.chainOf ?? ((id: number) => id);

  return {
    calls,
    files: {
      read: async (path) => store.get(path) ?? null,
      write: async (path, data) => {
        store.set(path, data);
      },
      exists: async (path) => store.has(path),
    },
    net: async (url) => {
      calls.push(url);
      const species = /\/pokemon-species\/(\d+)$/.exec(url);
      if (species !== null) {
        const id = Number(species[1]);
        if (missing.has(id)) return new Response("not found", { status: 404 });
        return new Response(
          JSON.stringify({
            capture_rate: 255,
            is_legendary: false,
            is_mythical: false,
            names: [{ language: { name: "en" }, name: `species-${id}` }],
            evolution_chain: {
              url: `https://pokeapi.co/api/v2/evolution-chain/${chainOf(id)}/`,
            },
          }),
          { status: 200 },
        );
      }
      const chain = /\/evolution-chain\/(\d+)$/.exec(url);
      if (chain !== null) {
        const root = Number(chain[1]);
        // Every species this chain claims, so a shared chain resolves a line for
        // each of its members rather than only for the one that asked.
        const members = [root, root + 1].map((id) => ({
          species: { url: `https://pokeapi.co/api/v2/pokemon-species/${id}/` },
          evolves_to: [],
        }));
        return new Response(
          JSON.stringify({
            chain: { ...members[0], evolves_to: [members[1]] },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    },
  };
}

/**
 * Polls the key route until it carries a name, the way the panel does.
 *
 * Bounded and throwing, for the same reason as `prefetched`: a warm that never
 * lands has to fail as a warm that never landed.
 */
async function namedBy(route: PluginRoute, apiKeyId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await route.handler({ params: { id: apiKeyId }, query: {}, body: null });
    const { name } = found.json as { name: string | null };
    if (name !== null) return name;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`no name ever landed for ${apiKeyId}`);
}

/**
 * Waits for the panel's prefetch to land a roll.
 *
 * The route fires it unawaited on purpose — a prefetch is an optimisation for
 * the next hatch and the panel has to render now — so a test that wants to see
 * the roll has to wait for it rather than assume it. Bounded, and it throws
 * rather than returning quietly: a prefetch that never lands must fail as a
 * prefetch that never landed, not as an assertion about a null.
 */
async function prefetched(apiKeyId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = readCompanion(storage, apiKeyId)?.state?.pendingHatch;
    if (pending !== null && pending !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`no roll ever landed for ${apiKeyId}`);
}

/** An active Pokémon, spelled out because every field here is a fixture decision. */
function activeMon(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseId: 1,
    plannedPath: [1, 2, 3],
    stageIndex: 0,
    usedAtStage: 0,
    rarity: "common",
    isShiny: false,
    nature: "sassy",
    dittoDisguise: null,
    dittoRevealed: false,
    ...over,
  };
}

/** The two capabilities a roll needs, when a test supplies them. */
type Capabilities = { net: PluginFetch; files: PluginFiles };

async function boot(
  config: Record<string, unknown> = {},
  // Partial, because a capability the manifest declares can still be absent and
  // the plugin has to degrade rather than throw — and the two halves degrade
  // differently, so a test needs to be able to withhold exactly one.
  capabilities: Partial<Capabilities> | null = null,
): Promise<void> {
  storage.migrate(companion.migrations ?? []);

  const context: PluginContext = {
    id: "pokemon",
    now: () => clock,
    logger: {
      debug: () => {},
      info: (message, fields) => logged.push({ message, event: fields?.event }),
      warn: () => {},
      error: () => {},
    },
    storage,
    // Neither capability by default: that is the offline install, and it is also
    // the shape that keeps this file off the network. Prefetching a species is
    // the one thing that needs them, and it degrades rather than throwing. A
    // test that has to watch a roll happen passes `cachedSpecies()`, whose
    // `net` throws — so even then nothing here can reach PokéAPI.
    ...(capabilities ?? {}),
    events: {
      onRequestCompleted: (handler) => {
        onRequest = handler;
      },
      onLimitReached: (handler) => {
        onLimit = handler;
      },
    },
    config,
  };

  const result = await companion.setup(context);
  routes = result?.routes ?? [];
}

beforeEach(() => {
  storage = createTestStorage();
  onRequest = null;
  onLimit = null;
  logged = [];
  clock = 1_700_000_000_000;
});

afterEach(() => {
  storage.close();
});

test("the plugin subscribes to both events and exposes its routes", async () => {
  await boot();
  expect(onRequest).not.toBeNull();
  expect(onLimit).not.toBeNull();
  expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
    "GET /keys",
    "GET /keys/:id",
    "GET /sprite/:species",
    "POST /keys/:id/purchase",
    "POST /keys/:id/unpin",
    "POST /keys/:id/use",
  ]);
});

test("a finished request credits its key and nobody else", async () => {
  await boot();
  spend(1_234);
  onRequest?.(
    completed({
      requestId: "req_x",
      apiKeyId: "key_other",
      tokens: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );

  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_234);
  expect(readCompanion(storage, "key_other")?.tokensTotal).toBe(99);
});

test("all four token classes count toward growth", async () => {
  // They are disjoint — `input` is uncached input — so summing them
  // double-counts nothing, and dropping any one of them would quietly halve a
  // cache-heavy install's growth.
  await boot();
  onRequest?.(completed({ tokens: { input: 1, output: 10, cacheRead: 100, cacheWrite: 1_000 } }));
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_111);
});

test("the operator's multiplier scales credits and is never retroactive", async () => {
  await boot({ multiplier: 10 });
  spend(1_000);
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(10_000);
});

test("a nonsense multiplier falls back to 1 rather than zeroing growth", async () => {
  // A zero or negative multiplier would stop every companion in the install
  // dead, with nothing to say why.
  for (const multiplier of [0, -5, Number.NaN, "fast"]) {
    storage.close();
    storage = createTestStorage();
    await boot({ multiplier });
    spend(500);
    expect(readCompanion(storage, KEY)?.tokensTotal).toBe(500);
  }
});

test("an egg with no species available holds its progress instead of losing it", async () => {
  // The offline install. There is no `net`, so nothing can be rolled — and the
  // incubation has to survive that, or an outage silently costs a player their
  // egg.
  await boot();
  spend(EGG_HATCH_THRESHOLD * 2);

  const row = readCompanion(storage, KEY);
  expect(row?.state?.active).toBeNull();
  expect(row?.state?.eggUsage).toBe(EGG_HATCH_THRESHOLD * 2);
  expect(row?.tokensTotal).toBe(EGG_HATCH_THRESHOLD * 2);
});

test("a companion hatches, grows and graduates into the Dex", async () => {
  // The whole arc through the real event path. The species is planted directly,
  // because rolling one needs the network and this test does not.
  await boot();
  spend(1_000);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      consumedTotal: 1_000,
      active: null,
      eggUsage: 1_000,
      eggTier: null,
      pendingHatch: {
        speciesId: 1,
        path: [1, 2, 3],
        rarity: "common",
        isShiny: true,
        nature: "jolly",
        ditto: false,
      },
      inventory: emptyInventory(),
      grantSeeded: false,
    }),
    KEY,
  ]);

  spend(EGG_HATCH_THRESHOLD + graduationTotal("common"), "req_big");

  const dex = readDex(storage, KEY);
  expect(dex).toHaveLength(1);
  expect(dex[0]).toMatchObject({ baseId: 1, finalId: 3, rarity: "common", isShiny: true });

  // And it is back to an egg, ready to start again.
  expect(readCompanion(storage, KEY)?.state?.active).toBeNull();
  expect(logged.some((l) => l.event === "companion.graduated")).toBe(true);
});

test("a weekly ceiling pays at most weekly, and never on the install itself", async () => {
  // The clock has to move here, and that is the point rather than a nuisance.
  // `LimitReached` fires continuously while a key is at its ceiling and says
  // nothing when it drops, so payment is rated by the window's own length. A
  // frozen clock means a window that can never re-arm — which is exactly what a
  // key parked at its limit should experience.
  await boot();
  spend(1_000);

  const limit: LimitReached = { apiKeyId: KEY, dimension: "tokens", window: "1w", at: 2_000 };
  const candy = () => readCompanion(storage, KEY)?.state?.inventory.rareCandy;

  // First sighting seeds and pays nothing.
  onLimit?.(limit);
  expect(candy()).toBe(0);

  // Still the same instant: a key parked at its ceiling is not a faucet.
  onLimit?.(limit);
  onLimit?.(limit);
  expect(candy()).toBe(0);

  clock += WINDOW_MS["1w"];
  onLimit?.(limit);
  expect(candy()).toBe(5);

  // And immediately again pays nothing more.
  onLimit?.(limit);
  expect(candy()).toBe(5);

  clock += WINDOW_MS["1w"];
  onLimit?.(limit);
  expect(candy()).toBe(10);
});

test("a five-hour window re-arms on its own schedule, not the weekly one", async () => {
  await boot();
  spend(1_000);
  const short: LimitReached = { apiKeyId: KEY, dimension: "requests", window: "5h", at: 1 };

  onLimit?.(short);
  clock += WINDOW_MS["5h"];
  onLimit?.(short);
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(1);
});

test("a minute ceiling pays nothing, however often it is hit", async () => {
  // Rated by its own length it would pay a candy a minute — 100M XP each,
  // ~144B a day against a 750M–6B graduation. The economy's premise is that
  // growth costs work, and a minute is not a span in which work happened.
  await boot();
  spend(1_000);
  const minute: LimitReached = { apiKeyId: KEY, dimension: "requests", window: "1m", at: 1 };
  for (let i = 0; i < 5; i++) {
    onLimit?.(minute);
    clock += WINDOW_MS["1m"];
  }
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(0);
});

test("a key at every ceiling at once is paid for none of them", async () => {
  // The install-instant windfall, end to end. Seeding is per window, so each of
  // these seeds and none pays — the earlier per-key flag paid for every window
  // after the first, up to eleven free candies for a key merely already at its
  // limits.
  await boot();
  spend(1_000);
  for (const dimension of ["tokens", "requests", "spend"] as const) {
    for (const window of ["1w", "5h"] as const) {
      onLimit?.({ apiKeyId: KEY, dimension, window, at: 1 });
    }
  }
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(0);
});

test("a limit on a key with no companion is ignored rather than crashing", async () => {
  // Limits fire for keys that have never served a request through this plugin.
  await boot();
  expect(() =>
    onLimit?.({ apiKeyId: "never-seen", dimension: "tokens", window: "1w", at: 1 }),
  ).not.toThrow();
});

test("the panel route reports a companion, and 404s for a key without one", async () => {
  await boot();
  spend(2_000);

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found.status).toBeUndefined();
  expect(found.json).toMatchObject({ tokensTotal: 2_000, wallet: 2_000 });

  const missing = await route.handler({ params: { id: "nobody" }, query: {}, body: null });
  expect(missing.status).toBe(404);
});

test("buying through the route spends the wallet and leaves growth alone", async () => {
  await boot();
  spend(ITEM_PRICES.mint * 3);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const bought = await route.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "mint" },
  });
  expect(bought.status).toBeUndefined();

  const row = readCompanion(storage, KEY);
  expect(row?.tokensTotal).toBe(ITEM_PRICES.mint * 3);
  expect(row?.tokensSpent).toBe(ITEM_PRICES.mint);
  expect(row?.state?.inventory.mint).toBe(1);
});

test("an unaffordable purchase is refused and changes nothing", async () => {
  await boot();
  spend(10);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  const refused = await route?.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "shinyCharm" },
  });

  expect(refused?.status).toBe(409);
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(0);
});

test("a disguised companion has its reveal resolved before it needs it", async () => {
  // The half of the reveal that `advance` cannot do. Ditto's line and rarity
  // live behind PokéAPI and the transition must not need them, so the answer is
  // written into the save while the disguise is still growing.
  const online = coldCacheOnline();
  await boot({}, online);
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon({
      baseId: 10,
      plannedPath: [10, 11],
      stageIndex: 0,
      dittoDisguise: 10,
      dittoRevealed: false,
    }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  for (let attempt = 0; attempt < 100; attempt++) {
    await route.handler({ params: { id: KEY }, query: {}, body: null });
    const pending = readCompanion(storage, KEY)?.state?.pendingReveal;
    if (pending != null) {
      expect(pending.path[0]).toBe(132);
      // Derived from the fetched capture rate rather than written down here, so
      // a hardcoded "Ditto is rare" cannot drift from what PokéAPI says.
      expect(pending.rarity).toBe("common");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the reveal was never resolved");
});

test("an ordinary companion never resolves a reveal it will not use", async () => {
  const online = coldCacheOnline();
  await boot({}, online);
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11], stageIndex: 0 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(readCompanion(storage, KEY)?.state?.pendingReveal).toBeNull();
  expect(online.calls.filter((url) => url.endsWith("/pokemon-species/132"))).toEqual([]);
});

test("an item that cannot do anything is refused rather than burned", async () => {
  // `consume` checked only that the item was held, then decremented and wrote
  // whatever the effect returned — and `useItem` returns the state untouched
  // when a mint has no companion to work on. So the mint vanished, nothing
  // happened, and the route answered `{ ok: true }`.
  await boot();
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    // An egg: there is no nature to reroll.
    active: null,
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    inventory: { ...emptyInventory(), rareCandy: 0, mint: 2, shinyCharm: 0 },
  });

  const use = routes.find((r) => r.path === "/keys/:id/use");
  const refused = await use?.handler({ params: { id: KEY }, query: {}, body: { item: "mint" } });

  expect(refused?.status).toBe(409);
  expect(refused?.json).toMatchObject({ error: "no-companion" });
  // The whole point: still two.
  expect(readCompanion(storage, KEY)?.state?.inventory.mint).toBe(2);
});

/** A companion with an everstone already on it. */
function pinnedCompanion(): void {
  plant({
    consumedTotal: 1_000,
    active: activeMon({ everstone: true }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: false,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  });
}

test("a pinned companion is released without spending a second stone", async () => {
  // Release cannot go through `use`: `consume` refuses when the count is zero,
  // so releasing would mean holding a *spare* stone and then spending it to undo
  // the first. Pinning would be a trap rather than a choice.
  await boot();
  spend(1_000);
  pinnedCompanion();

  const unpin = routes.find((r) => r.path === "/keys/:id/unpin");
  const released = await unpin?.handler({ params: { id: KEY }, query: {}, body: null });

  expect(released?.status).toBeUndefined();
  const state = readCompanion(storage, KEY)?.state;
  expect(state?.active?.everstone).toBe(false);
  expect(state?.inventory.everstone).toBe(0);
});

test("releasing a companion that is not pinned is refused", async () => {
  await boot();
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon(),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: false,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  });

  const unpin = routes.find((r) => r.path === "/keys/:id/unpin");
  const refused = await unpin?.handler({ params: { id: KEY }, query: {}, body: null });

  expect(refused?.status).toBe(409);
});

test("a second everstone is refused rather than spent on an already-pinned companion", async () => {
  await boot();
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon({ everstone: true }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: false,
    incense: false,
    repel: null,
    inventory: { ...emptyInventory(), everstone: 1 },
  });

  const use = routes.find((r) => r.path === "/keys/:id/use");
  const refused = await use?.handler({
    params: { id: KEY },
    query: {},
    body: { item: "everstone" },
  });

  expect(refused?.status).toBe(409);
  expect(readCompanion(storage, KEY)?.state?.inventory.everstone).toBe(1);
});

test("releasing a pinned companion lets its banked growth spend itself", async () => {
  // End to end: the growth accrued while pinned is still there and settles the
  // moment the stone comes off.
  await boot();
  spend(graduationTotal("common") * 2);
  plant({
    consumedTotal: graduationTotal("common") * 2,
    // Banked *in* `usedAtStage`, which is where a pinned companion's growth
    // accumulates. Setting only `consumedTotal` would leave nothing to release:
    // `advance` works from the difference, and that difference is already spent.
    active: activeMon({
      baseId: 10,
      plannedPath: [10, 11],
      stageIndex: 0,
      everstone: true,
      usedAtStage: graduationTotal("common"),
    }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: false,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  // Pinned, so nothing moved.
  expect(readCompanion(storage, KEY)?.state?.active?.stageIndex).toBe(0);

  const unpin = routes.find((r) => r.path === "/keys/:id/unpin");
  await unpin?.handler({ params: { id: KEY }, query: {}, body: null });

  expect(readCompanion(storage, KEY)?.state?.active).toBeNull();
  expect(readDex(storage, KEY)).toHaveLength(1);
});

test("a lure steers the next roll and is spent by it", async () => {
  await boot(
    {},
    cachedSpecies([
      { id: 10, captureRate: 255, forms: 3, finalId: 12 },
      { id: 20, captureRate: 255, forms: 3, finalId: 22 },
    ]),
  );
  spend(100);
  // Species 12 already collected, so a lure must produce the other line.
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 10,
      finalId: 12,
      chainOrder: [10, 11, 12],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_1",
  );
  plant({
    consumedTotal: 100,
    active: null,
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: true,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);

  const state = readCompanion(storage, KEY)?.state;
  expect(state?.pendingHatch?.speciesId).toBe(20);
  // Spent by the roll it shaped, so one purchase buys one hatch.
  expect(state?.lure).toBe(false);
});

test("a lure with nothing left to find waits rather than being spent", async () => {
  // The whole Dex collected. Filtering to uncollected would empty the candidate
  // pool, and an empty pool is indistinguishable from "the index has not
  // arrived" — so the egg would quietly never hatch and the lure would be gone.
  await boot({}, cachedSpecies([{ id: 10, captureRate: 255, forms: 3, finalId: 12 }]));
  spend(100);
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 10,
      finalId: 12,
      chainOrder: [10, 11, 12],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_1",
  );
  plant({
    consumedTotal: 100,
    active: null,
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: true,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);

  const state = readCompanion(storage, KEY)?.state;
  // It hatched anyway — a duplicate is better than a companion that never comes.
  expect(state?.pendingHatch?.speciesId).toBe(10);
  // And the lure is still there, to be used the day something new exists.
  expect(state?.lure).toBe(true);
});

test("the shop is listed cheapest first", async () => {
  // The catalogue was `ITEM_PRICES` key order followed by the eggs, which put
  // 3B above 1B and read as an arbitrary pile. PokeTokenBar shipped and fixed
  // the same display bug; this is the assertion that keeps a later entry from
  // being appended somewhere arbitrary again.
  await boot();
  spend(1_000);

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
  const { shop } = found.json as { shop: Array<{ price: number }> };
  const prices = shop.map((offer) => offer.price);
  expect(prices).toEqual([...prices].sort((a, b) => a - b));
  // Every entry still present: a sort that dropped one would satisfy the above.
  // Derived rather than a literal, so adding an item does not require editing a
  // number here — a count that has to be maintained by hand is a count that gets
  // maintained by deleting the assertion.
  expect(prices).toHaveLength(ITEM_KINDS.length + EGG_TIERS_ON_SALE);
});

test("an unknown shop entry is refused before it can be priced", async () => {
  await boot();
  spend(10_000_000_000);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  for (const body of [
    { kind: "item", item: "masterBall" },
    { kind: "egg", tier: "legendary" },
    { kind: "nonsense" },
    null,
    "egg",
  ]) {
    const refused = await route?.handler({ params: { id: KEY }, query: {}, body });
    expect(refused?.status).toBe(400);
  }
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(0);
});

test("a sprite request without the net capability degrades rather than throwing", async () => {
  await boot();
  const route = routes.find((r) => r.path === "/sprite/:species");
  const response = await route?.handler({ params: { species: "25" }, query: {}, body: null });
  expect(response?.status).toBe(503);
});

test("a non-numeric species id is refused before any lookup", async () => {
  await boot();
  const route = routes.find((r) => r.path === "/sprite/:species");
  const response = await route?.handler({
    params: { species: "../secret" },
    query: {},
    body: null,
  });
  expect(response?.status).toBe(400);
});

test("earning stamps the credit instant, and the panel route reports it", async () => {
  // The one signal the panel's activity state is derived from. It has to be the
  // instant rather than a label, and it has to come from the credit rather than
  // from the row changing.
  await boot();
  clock = 1_700_000_123_000;
  spend(2_000);

  expect(readCompanion(storage, KEY)?.lastCreditAt).toBe(1_700_000_123_000);

  // The second credit takes a different path — the row exists now, so this is
  // the `ON CONFLICT` branch rather than the insert — and the panel needs the
  // latest instant, not the first one ever recorded.
  clock = 1_700_000_456_000;
  spend(3_000, "req_second");
  expect(readCompanion(storage, KEY)?.lastCreditAt).toBe(1_700_000_456_000);

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ lastCreditAt: 1_700_000_456_000 });
});

test("shopping is not working: a purchase leaves the credit instant alone", async () => {
  // `updated_at` moves here and `last_credit_at` must not, which is the whole
  // reason the column was added rather than the existing one being read. A
  // companion whose operator bought a mint has not served a request.
  await boot();
  clock = 1_700_000_500_000;
  spend(ITEM_PRICES.mint * 2);
  // An active companion, because a mint needs a nature to reroll and is now
  // refused without one. This fixture used to be an egg and the assertion below
  // was that using the mint succeeded — pinning the burn as correct, which is
  // the same trap the mint's own comment already records it falling into once.
  plant({
    consumedTotal: ITEM_PRICES.mint * 2,
    active: activeMon(),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    inventory: emptyInventory(),
  });

  clock = 1_700_009_000_000;
  const buy = routes.find((r) => r.path === "/keys/:id/purchase");
  const bought = await buy?.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "mint" },
  });
  expect(bought?.status).toBeUndefined();
  expect(readCompanion(storage, KEY)?.lastCreditAt).toBe(1_700_000_500_000);

  // And neither does spending what was bought.
  clock = 1_700_012_000_000;
  const use = routes.find((r) => r.path === "/keys/:id/use");
  const used = await use?.handler({ params: { id: KEY }, query: {}, body: { item: "mint" } });
  expect(used?.status).toBeUndefined();
  expect(readCompanion(storage, KEY)?.lastCreditAt).toBe(1_700_000_500_000);
});

test("a companion written before the column still reads back after it is added", async () => {
  // Migration safety. An install that has been running since before migration 5
  // has rows with no `last_credit_at`, and adding the column must leave every
  // one of them readable — growth, wallet and save intact, with the new field
  // reading as "never observed" rather than as an instant nobody recorded.
  const earlier = (companion.migrations ?? []).filter((m) => m.version <= 4);
  expect(earlier).toHaveLength(4);
  storage.migrate(earlier);

  storage.run(
    `INSERT INTO {{companion}} (api_key_id, state, tokens_total, tokens_spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [KEY, serialiseState(freshState()), 4_321, 21, 111, 222],
  );

  // `boot` runs the full migration list, so version 5 lands on the row above.
  await boot();

  const row = readCompanion(storage, KEY);
  expect(row?.tokensTotal).toBe(4_321);
  expect(row?.tokensSpent).toBe(21);
  expect(row?.state).not.toBeNull();
  expect(row?.lastCreditAt).toBeNull();

  // And the panel route serves it rather than throwing on the missing value.
  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.status).toBeUndefined();
  expect(found?.json).toMatchObject({ lastCreditAt: null, tokensTotal: 4_321 });

  // The next credit fills it in, so the row is not permanently activity-less.
  clock = 1_700_000_777_000;
  spend(9);
  expect(readCompanion(storage, KEY)?.lastCreditAt).toBe(1_700_000_777_000);
});

test("a held item cannot be spent, however the request is spelled", async () => {
  // `shinyCharm` costs a whole rare graduation and is bought once to be held
  // forever. `consume` decrements whatever item it is handed and has no notion
  // of a passive one, so the only thing standing between a three-billion-token
  // purchase and a single-use consumable is the allowlist in `parseHeldItem`.
  //
  // That allowlist used to be shadowed by an exported `PASSIVE_ITEMS` set that
  // nothing read — the right fact in the wrong place, stating a rule while a
  // literal elsewhere enforced it. The set is gone and this is what replaced it.
  await boot();
  spend(ITEM_PRICES.shinyCharm);

  const buy = routes.find((r) => r.path === "/keys/:id/purchase");
  const bought = await buy?.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "shinyCharm" },
  });
  expect(bought?.status).toBeUndefined();
  expect(readCompanion(storage, KEY)?.state?.inventory.shinyCharm).toBe(1);

  const use = routes.find((r) => r.path === "/keys/:id/use");
  const refused = await use?.handler({
    params: { id: KEY },
    query: {},
    body: { item: "shinyCharm" },
  });

  // 400, not 409: the item is held, so "none-held" would be a lie. It is not
  // spendable at all, which is a bad request rather than a conflict.
  expect(refused?.status).toBe(400);
  expect(readCompanion(storage, KEY)?.state?.inventory.shinyCharm).toBe(1);
});

test("the charm in the bag reaches the roll the panel prefetches", async () => {
  // The other end of the same seam `roll.test.ts` pins from the pure side, and
  // the one that matters commercially: `hasShinyCharm(state)` at the prefetch is
  // the entire return on a 3,000,000,000-token purchase, and it could have been
  // written `false` with every suite in the package green.
  //
  // The same key and the same credited total in both halves, so the seed —
  // derived from exactly those two facts — is identical and the only difference
  // between the two rolls is the charm. 902 was chosen because the shiny draw
  // for that seed falls between 1/64 and 1/48, which is the band the charm
  // moves; any other total would leave both rolls on the same side of it and
  // prove nothing.
  await boot({}, cachedSpecies());
  spend(902);

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);
  expect(readCompanion(storage, KEY)?.state?.pendingHatch).toMatchObject({
    speciesId: 10,
    isShiny: false,
  });

  // Now the same egg with a charm in the bag: the prefetch is dropped so it is
  // rolled again, and nothing else about the save moves.
  plant({
    consumedTotal: 902,
    active: null,
    eggUsage: 902,
    eggTier: null,
    pendingHatch: null,
    inventory: { ...emptyInventory(), rareCandy: 0, mint: 0, shinyCharm: 1 },
  });

  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);
  expect(readCompanion(storage, KEY)?.state?.pendingHatch).toMatchObject({
    speciesId: 10,
    isShiny: true,
  });
});

test("a mint actually rerolls the nature it was spent on", async () => {
  // The item's whole effect, and until now nothing read `active.nature` after a
  // mint at all: `useItem` could go back to `return state` — which is what it
  // used to be, a no-op incrementing a counter a test then pinned as correct —
  // and every suite would stay green while the operator's 100M bought nothing.
  //
  // "sassy" rather than "hardy" on purpose. "hardy" is `parseState`'s fallback
  // for an unreadable nature *and* the first entry of the cycle, so a fixture
  // starting there cannot tell a reroll from a default from a no-op.
  await boot();
  spend(ITEM_PRICES.mint);
  plant({
    consumedTotal: ITEM_PRICES.mint,
    active: activeMon({ usedAtStage: 111, nature: "sassy" }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: { ...emptyInventory(), rareCandy: 0, mint: 1, shinyCharm: 0 },
  });
  expect(readCompanion(storage, KEY)?.state?.active?.nature).toBe("sassy");

  const use = routes.find((r) => r.path === "/keys/:id/use");
  const used = await use?.handler({ params: { id: KEY }, query: {}, body: { item: "mint" } });
  expect(used?.status).toBeUndefined();

  const after = readCompanion(storage, KEY)?.state;
  expect(after?.active?.nature).not.toBe("sassy");
  // The next nature in the cycle, which is deterministic on purpose — a reroll
  // needing entropy would be the one thing in this plugin that cannot be
  // reproduced.
  expect(after?.active?.nature).toBe("careful");
  // And nothing else moved: a mint is cosmetic, so growth and the rest of the
  // save are untouched and the mint itself is gone from the bag.
  expect(after?.active?.usedAtStage).toBe(111);
  expect(after?.active?.stageIndex).toBe(0);
  expect(after?.inventory.mint).toBe(0);
});

test("a guaranteed egg discards the roll the old egg was already holding", async () => {
  // The most expensive failure in the plugin. The panel prefetches a roll on
  // every poll, so an incubating egg normally *has* a `pendingHatch` — and if
  // buying a fresh egg stopped clearing it, the 4,000,000,000-token rare
  // guarantee would hatch the stale common that was already sitting there. The
  // operator pays for a rarity floor and gets whatever the old egg had rolled,
  // with nothing anywhere to say so.
  await boot();
  const price = freshEggPrice("rare");
  spend(price);
  plant({
    consumedTotal: price,
    active: null,
    eggUsage: 4_000_000,
    eggTier: null,
    pendingHatch: {
      speciesId: 10,
      path: [10, 11, 12],
      rarity: "common",
      isShiny: false,
      nature: "jolly",
      ditto: false,
    },
    inventory: emptyInventory(),
  });

  const buy = routes.find((r) => r.path === "/keys/:id/purchase");
  const bought = await buy?.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "egg", tier: "rare" },
  });
  expect(bought?.status).toBeUndefined();

  const after = readCompanion(storage, KEY)?.state;
  expect(after?.eggTier).toBe("rare");
  expect(after?.pendingHatch).toBeNull();
  expect(after?.eggUsage).toBe(0);

  // And the consequence, which is the part a player would notice: crediting past
  // the hatch threshold cannot open the discarded common. There is no `net` in
  // this install, so no replacement roll can land either — the egg waits, which
  // is the honest outcome.
  spend(EGG_HATCH_THRESHOLD * 2, "req_after_egg");
  const settled = readCompanion(storage, KEY)?.state;
  expect(settled?.active).toBeNull();
  expect(settled?.eggUsage).toBe(EGG_HATCH_THRESHOLD * 2);
});

test("the panel route prices the stage a companion is actually on", async () => {
  // The route computes `nextThreshold` and nothing ever read it: the UI suite
  // supplies the field as a fixture, and that fixture's value happens to equal
  // `EGG_HATCH_THRESHOLD` — two numbers that are the same by coincidence, which
  // is precisely the shape that hides a swapped branch. Collapsing the ternary
  // to a bare `EGG_HATCH_THRESHOLD` passed every test in the package.
  await boot();
  spend(7_000);
  plant({
    consumedTotal: 7_000,
    // Stage 2 of an uncommon three-form line: 1,875,000,000 × 2 / 6.
    active: activeMon({ rarity: "uncommon", stageIndex: 1, usedAtStage: 3_333 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });

  // Written out rather than recomputed with `phaseThreshold`, so the assertion
  // cannot agree with the route by running the same function.
  expect(found?.json).toMatchObject({ nextThreshold: 625_000_000, progress: 3_333 });
  expect(625_000_000).not.toBe(EGG_HATCH_THRESHOLD);

  // The other branch, for the same reason in the other direction: an egg is
  // priced at the hatch threshold and its progress is the incubation.
  onRequest?.(
    completed({
      requestId: "req_egg_key",
      apiKeyId: "key_egg",
      tokens: { input: 1_234_567, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );
  const egg = await route?.handler({ params: { id: "key_egg" }, query: {}, body: null });
  expect(egg?.json).toMatchObject({
    nextThreshold: EGG_HATCH_THRESHOLD,
    progress: 1_234_567,
  });
});

test("an outsized multiplier is capped rather than trusted", async () => {
  // The cap's stated purpose is that `tokens_total` never reaches
  // MAX_SAFE_INTEGER, where addition quietly stops being addition and the growth
  // meter becomes fiction. The existing coverage tries 10, 0, -5, NaN and
  // "fast" — every one of them below the cap — so removing `Math.min` changed
  // nothing any test could see.
  await boot({ multiplier: 2_500 });
  spend(1_000);
  // 1,000 × MAX_MULTIPLIER, not 1,000 × 2,500.
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_000_000);

  // And the mistyped exponent the comment names, which is the case that would
  // otherwise put the counter past what a JavaScript integer can hold.
  storage.close();
  storage = createTestStorage();
  await boot({ multiplier: 1e21 });
  spend(1_000);

  const total = readCompanion(storage, KEY)?.tokensTotal ?? 0;
  expect(total).toBe(1_000_000);
  expect(total).toBeLessThan(Number.MAX_SAFE_INTEGER);
});

test("the shipped manifest is compatible with the SDK and API the host ships", () => {
  // The failure this catches is silent by design. A manifest whose `sdk` range
  // no longer matches the console's version does not error — the host disables
  // the UI and keeps the server half running, which is the right behaviour for a
  // third-party plugin and exactly wrong for the one shipped in this repository.
  // The panel would simply stop appearing, with nothing red anywhere.
  //
  // It has already been possible once: moving the SDK from 1.0.0 to 0.1.0 left
  // this manifest on `^1.0.0`, and all 216 tests passed.
  //
  // `Bun.semver.satisfies` with the arguments in the host's order, so this asks
  // the same question `loader.ts` asks rather than a similar one.
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "omni-plugin.json"), "utf8"),
  ) as { api: number; sdk: string };

  expect(Bun.semver.satisfies(DASHBOARD_SDK_VERSION, manifest.sdk)).toBe(true);
  expect(manifest.api).toBe(PLUGIN_API_VERSION);
});

test("the tier a guaranteed egg was paid for reaches the roll, not just the save", async () => {
  // The second seam of the same purchase, and the one that survived when the
  // first was covered. `applyPurchase` recording `eggTier` is asserted elsewhere;
  // this is `guarantee: state.eggTier` at the prefetch, which could have been
  // written `null` with all 136 tests green. A rare egg costs 4,000,000,000
  // tokens and its entire return is that one field arriving here.
  //
  // Discriminated by eligibility rather than by seed. Capture rate is the roll's
  // weight directly, so with a 255 and a 3 in the pool the common wins ~99% of
  // draws — but a `rare` guarantee removes the common from the pool outright, so
  // the outcome is fixed rather than probable and no seed hunting is involved.
  const pool = [COMMON_SPECIES, { id: 20, captureRate: 3, forms: 1, finalId: 20 }];

  await boot({}, cachedSpecies(pool));
  spend(902);

  const route = routes.find((r) => r.path === "/keys/:id");
  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);

  // Unguaranteed: the heavily weighted common, which is what makes the paid
  // version worth anything.
  expect(readCompanion(storage, KEY)?.state?.pendingHatch).toMatchObject({
    speciesId: 10,
    rarity: "common",
  });

  // The same key and the same credited total, so the seed is identical and the
  // guarantee is the only thing that differs between the two rolls.
  plant({
    consumedTotal: 902,
    active: null,
    eggUsage: 902,
    eggTier: "rare",
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  await route?.handler({ params: { id: KEY }, query: {}, body: null });
  await prefetched(KEY);

  expect(readCompanion(storage, KEY)?.state?.pendingHatch).toMatchObject({
    speciesId: 20,
    rarity: "rare",
  });
});

// --- the roster and the names --------------------------------------------------

test("the roster route lists each key that has a companion, with what it is showing", async () => {
  // The route the panel opens on. Before it existed an operator had to already
  // know a key id to see anything at all, and nothing in the console shows the
  // ids of keys that have companions.
  await boot({}, cachedSpecies());
  clock = 1_700_000_100_000;
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 0, rarity: "rare" }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  clock = 1_700_000_200_000;
  onRequest?.(
    completed({
      requestId: "req_other",
      apiKeyId: "key_other",
      tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );

  const route = routes.find((r) => r.path === "/keys");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const listed = await route.handler({ params: {}, query: {}, body: null });
  expect(listed.status).toBeUndefined();
  expect(listed.json).toEqual({
    keys: [
      // The later earner first, which is the order the roster is sorted in.
      {
        apiKeyId: "key_other",
        speciesId: null,
        name: null,
        rarity: null,
        isShiny: false,
        tokensTotal: 7,
        wallet: 7,
        lastCreditAt: 1_700_000_200_000,
        unreadable: false,
      },
      {
        apiKeyId: KEY,
        speciesId: 10,
        name: "species-10",
        rarity: "rare",
        isShiny: false,
        tokensTotal: 5_000,
        wallet: 5_000,
        lastCreditAt: 1_700_000_100_000,
        unreadable: false,
      },
    ],
  });
});

test("a key whose save cannot be read is listed as unreadable rather than dropped", async () => {
  // The one key an operator most needs to find is the broken one. Hiding it
  // from the only surface that lists companions is how it stays broken.
  await boot();
  spend(1_000);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", ["{ broken", KEY]);

  const route = routes.find((r) => r.path === "/keys");
  const listed = await route?.handler({ params: {}, query: {}, body: null });
  expect(listed?.json).toMatchObject({
    keys: [{ apiKeyId: KEY, unreadable: true, speciesId: null, name: null }],
  });
});

test("the roster is empty on an install where nothing has spent a token", async () => {
  await boot();
  const route = routes.find((r) => r.path === "/keys");
  const listed = await route?.handler({ params: {}, query: {}, body: null });
  expect(listed?.json).toEqual({ keys: [] });
});

test("the panel names the stage the companion is standing at, not its base", async () => {
  await boot(
    {},
    cachedSpecies([
      { id: 10, captureRate: 255, forms: 3, finalId: 12 },
      { id: 11, captureRate: 255, forms: 3, finalId: 12 },
    ]),
  );
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ name: "species-11" });
});

test("a species the cache has never seen shows no name rather than a wrong one", async () => {
  // The cold-cache case and the offline install are the same case here: the
  // name is decoration, and the panel falls back to the species number.
  await boot();
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 0 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ name: null });
});

test("a hatched companion whose species cache was wiped gets its name back", async () => {
  // The bug this closes: `prefetchHatch` is the only thing that ever filled the
  // species cache, and it returns early once a companion is active. So a save
  // that hatched before a restore showed `#11` on every poll for the life of the
  // install — the cache could not refill, because the one thing that filled it
  // only ran for eggs.
  const online = coldCacheOnline();
  await boot({}, online);
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  // The first poll still answers with the number: warming is best effort and
  // unawaited, so the panel renders now and the name arrives later.
  const first = await route.handler({ params: { id: KEY }, query: {}, body: null });
  expect(first.json).toMatchObject({ name: null });

  expect(await namedBy(route, KEY)).toBe("species-11");
});

test("a name that has already been warmed is never fetched twice", async () => {
  // The reason `cachedSpeciesName` has no `net` in the first place. A panel
  // polling every fifteen seconds must not turn into a request per poll, so a
  // species is asked for once per process and answered from disk after that.
  const online = coldCacheOnline();
  await boot({}, online);
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  expect(await namedBy(route, KEY)).toBe("species-11");
  const settled = online.calls.length;

  for (let poll = 0; poll < 5; poll++) {
    const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
    expect(found.json).toMatchObject({ name: "species-11" });
  }
  expect(online.calls.length).toBe(settled);
});

test("a dex entry the cache has never seen is warmed too", async () => {
  const online = coldCacheOnline();
  await boot({}, online);
  spend(1_000);
  // An *active* companion, and that is the fixture decision the test turns on:
  // an egg would set `prefetchHatch` building the whole species index, which
  // caches every document there is and would name the Dex entry without any of
  // the warming this test is about.
  plant({
    consumedTotal: 1_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 0 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 20,
      finalId: 22,
      chainOrder: [20, 21, 22],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_1",
  );

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
    const { dex } = found.json as { dex: Array<{ name: string | null }> };
    if (dex[0]?.name === "species-22") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the dex entry never got its name");
});

test("a species PokéAPI has forgotten is asked for once, not once per poll", async () => {
  // The bug the first version of the warm-up shipped. `fetchJson` collapses a
  // 404 and an outage into the same null, so "it failed, the network must be
  // down" is an assumption that never expires — and a species PokéAPI has no
  // document for was re-fetched on every poll, forever, for as long as any
  // operator left the panel open.
  const online = coldCacheOnline({ missing: [11] });
  await boot({}, online);
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  for (let poll = 0; poll < 10; poll++) {
    const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
    // Still honest about what it does not know, on every one of them.
    expect(found.json).toMatchObject({ name: null });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  // `clock` never moves in this test, so the backoff never expires and one
  // attempt is the whole budget. A clock that advanced past an hour would
  // legitimately see a second.
  expect(online.calls.filter((url) => url.endsWith("/pokemon-species/11"))).toHaveLength(1);
});

test("a forgotten species does not starve the entries behind it", async () => {
  // The other half of the same bug, and the worse half: the warm budget is
  // eight per poll and `readDex` orders by `caught_at`, so eight permanently
  // unnameable rows sat at the front of the queue and every entry behind them
  // was unreachable for the life of the process.
  const dead = [30, 31, 32, 33, 34, 35, 36, 37];
  const online = coldCacheOnline({ missing: dead });
  await boot({}, online);
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 0 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  // The eight dead rows are the newest, so they are what a poll reaches first.
  dead.forEach((finalId, index) => {
    recordGraduation(
      storage,
      KEY,
      {
        baseId: finalId,
        finalId,
        chainOrder: [finalId],
        rarity: "common",
        isShiny: false,
        nature: "sassy",
        caughtAt: 1_700_000_500_000 + index,
      },
      `dex_dead_${finalId}`,
    );
  });
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 22,
      finalId: 22,
      chainOrder: [22],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_live",
  );

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
    const { dex } = found.json as { dex: Array<{ finalId: number; name: string | null }> };
    if (dex.find((entry) => entry.finalId === 22)?.name === "species-22") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the reachable entry was starved by the unreachable ones");
});

test("one poll's warms share a chain rather than fetching it once each", async () => {
  // A Dex holds one row per graduation, so two rows commonly sit on one
  // evolution line. `speciesDetail` builds a fresh chain cache per call, which
  // is right for a lone lookup and would have fetched — and rewritten — the same
  // chain document once per species in a batch.
  const online = coldCacheOnline({ chainOf: () => 40 });
  await boot({}, online);
  spend(1_000);
  plant({
    consumedTotal: 1_000,
    active: activeMon({ baseId: 40, plannedPath: [40, 41], stageIndex: 0 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 40,
      finalId: 41,
      chainOrder: [40, 41],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_1",
  );

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  expect(await namedBy(route, KEY)).toBe("species-40");
  expect(online.calls.filter((url) => url.endsWith("/evolution-chain/40"))).toHaveLength(1);
});

test("the roster never warms a name, however many keys it lists", async () => {
  // A regression guard rather than a check on anything this route does: the
  // roster has never warmed and the point is that it stays that way. It is a
  // list of front doors and an operator may have fifty of them; the key's own
  // route warms what it is showing, because that is the one companion being
  // looked at.
  const online = coldCacheOnline();
  await boot({}, online);
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });
  // A second key, so "however many" is a claim the fixture actually makes.
  onRequest?.(
    completed({
      requestId: "req_other",
      apiKeyId: "key_2",
      tokens: { input: 3_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      consumedTotal: 0,
      active: activeMon({ baseId: 20, plannedPath: [20, 21], stageIndex: 0 }),
      eggUsage: 0,
      eggTier: null,
      pendingHatch: null,
      inventory: emptyInventory(),
    }),
    "key_2",
  ]);

  const route = routes.find((r) => r.path === "/keys");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const found = await route.handler({ params: {}, query: {}, body: null });
  const { keys } = found.json as { keys: Array<{ apiKeyId: string; name: string | null }> };
  expect(keys).toHaveLength(2);
  expect(keys.every((key) => key.name === null)).toBe(true);
  expect(online.calls).toEqual([]);
});

test("an install with no outbound access warms nothing and shows the number", async () => {
  // `net` absent is a supported configuration, not a broken one. There is no
  // stub to observe in this direction — that is the point of the capability
  // being missing — so what this pins is that the route still answers, and
  // answers honestly, rather than throwing on a `net` that is not there.
  const online = coldCacheOnline();
  await boot({}, { files: online.files });
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ name: null });
});

test("an install with no files capability never reaches the network to warm", async () => {
  // The observable half of the same guard, and the one that could actually go
  // wrong: `warmNames` checks both capabilities, and dropping the `files` half
  // would fetch a species document there is nowhere to cache — a request made
  // once per poll, forever, whose result is discarded every time.
  const reached: string[] = [];
  await boot(
    {},
    {
      net: async (url) => {
        reached.push(url);
        throw new Error(`warmed ${url} with nowhere to cache it`);
      },
    },
  );
  spend(5_000);
  plant({
    consumedTotal: 5_000,
    active: activeMon({ baseId: 10, plannedPath: [10, 11, 12], stageIndex: 1 }),
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    inventory: emptyInventory(),
  });

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ name: null });
  // A tick, so a warm fired unawaited would have reached the stub by now.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(reached).toEqual([]);
});

test("an egg has no species to name", async () => {
  await boot({}, cachedSpecies());
  spend(100);

  const route = routes.find((r) => r.path === "/keys/:id");
  const found = await route?.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found?.json).toMatchObject({ name: null });
});

test("a dex entry carries the name of what it graduated into", async () => {
  await boot({}, cachedSpecies([{ id: 12, captureRate: 255, forms: 1, finalId: 12 }]));
  spend(1_000);
  recordGraduation(
    storage,
    KEY,
    {
      baseId: 10,
      finalId: 12,
      chainOrder: [10, 11, 12],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      caughtAt: 1_700_000_000_000,
    },
    "dex_1",
  );

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
  const { dex } = found.json as { dex: Array<{ finalId: number; name: string | null }> };
  expect(dex).toHaveLength(1);
  expect(dex[0]).toMatchObject({ finalId: 12, name: "species-12" });
});
