/**
 * The companion panel, rendered.
 *
 * Run by `bun run test:ui`, not by `bun run test` — which globs `./test/*.test.ts`
 * and so does not match a `.tsx` file. (An earlier version of this comment
 * credited a `bunfig.toml` and a `test:plugins` script, neither of which exists
 * in this repository; the exclusion is that glob and nothing else.)
 *
 * The reason for the split is the DOM: registering one mutates process-wide globals,
 * so a file that registers its own inside the shared root run leaks a document
 * into ~2400 gateway, store and router tests that never asked for one. That is
 * not theoretical; it surfaced as a one-in-several-runs failure before the
 * preload existed. The console's suite is separated for exactly this reason and
 * this follows it.
 *
 * The harness is a local minimum rather than `apps/dashboard/test/helpers`.
 * `renderWithProviders` pulls in the console's `ThemeProvider` and
 * `LiveProvider` from `apps/dashboard/src`, and a plugin may not import an app.
 * What is copied is the *idiom*: a route table over `fetch` that answers a
 * missing route with a loud 501 rather than a hanging socket, and assertions on
 * visible text and accessible names. The API reaches the component through the
 * real `createPluginApi`, so URL construction is exercised too.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createPluginApi, LiveProvider, useLive } from "@omnigateway/dashboard-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Dex } from "../ui/Dex.tsx";
import { eggSpriteUrl, itemSpriteUrl } from "../ui/format.ts";
import companionUi, { activityOf } from "../ui/index.tsx";

const Companion = companionUi.mount;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  // The panel remembers which sections are folded, and `localStorage` is
  // process-wide. Without this, the first test to fold something decides the
  // layout for every test that runs after it.
  globalThis.localStorage?.clear();
});

/* -------------------------------------------------------------------------- */
/* the harness                                                                 */
/* -------------------------------------------------------------------------- */

type StubResponse = { status?: number; body?: unknown };

type StubHandler = (input: { url: string; body: string | undefined }) => StubResponse;

type FetchStub = {
  calls: Array<{ method: string; url: string; body: string | undefined }>;
};

type Mounted = FetchStub & { unmount: () => void; client: QueryClient };

function stubFetch(routes: Record<string, StubHandler>): FetchStub {
  const table = new Map(Object.entries(routes));
  const calls: FetchStub["calls"] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body });

    const handler = table.get(`${method} ${url}`);
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: `no stub for ${method} ${url}` } }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }

    const result = handler({ url, body });
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { calls };
}

/**
 * Mount the panel the way the host does: `mount` called in render position with
 * the two props the SDK promises, and nothing else in scope.
 *
 * **No `LiveProvider` by default, and that is the console's own contract rather
 * than a shortcut.** `useLive` outside a provider reports paused, so `cadence`
 * returns `false` and neither query polls — which is what makes every test
 * below able to assert an exact sequence of fetches. Pass `live: true` for the
 * two that are about polling; the provider comes from the SDK, which a plugin
 * may import, unlike the console's own `session/live.tsx`.
 */
function renderCompanion(
  routes: Record<string, StubHandler>,
  options: { live?: boolean; chassis?: boolean } = {},
): Mounted {
  const stub = stubFetch(routes);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const panel = (
    <QueryClientProvider client={client}>
      <Companion api={createPluginApi("pokemon")} pluginId="pokemon" />
    </QueryClientProvider>
  );
  const wrapped =
    options.chassis === true ? (
      <Chassis>{panel}</Chassis>
    ) : options.live === true ? (
      <LiveProvider>{panel}</LiveProvider>
    ) : (
      panel
    );
  const { unmount } = render(wrapped);
  // `unmount` is returned for the one thing that needs it: a preference stored
  // by one mount and read back by the next. Every other test mounts once.
  return { ...stub, unmount, client };
}

/**
 * What `refetchInterval` a live query ended up with.
 *
 * Read off the cache rather than waited for, because the alternative is a test
 * that sleeps ten seconds to watch one refetch — and a shorter interval would
 * mean changing the constant under test to observe it. This asserts the wiring,
 * which is the part that breaks: `cadence(REFETCH_MS)` reaching the query, or
 * not.
 */
function intervalOf(client: QueryClient, key: readonly unknown[]): unknown {
  // Off the *observer*, not the query. A `Query` holds the options every
  // observer agreed on and `refetchInterval` is not among them — it belongs to
  // the subscription, which is the thing that owns the timer.
  const query = client.getQueryCache().find({ queryKey: key });
  return query?.observers[0]?.options.refetchInterval;
}

/**
 * Type a key id into the fallback field and ask for it.
 *
 * The fallback, not the main path: an operator with a roster clicks a card. This
 * is what is left for the key that has never spent a token — it has no
 * companion row, so it cannot appear on a roster built from those rows — and for
 * the install whose roster route is unreachable.
 */
async function lookUp(keyId: string): Promise<void> {
  await userEvent.type(await screen.findByRole("textbox", { name: "API key id" }), keyId);
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
}

/**
 * Wait for the companion itself, however the panel got there.
 *
 * Every fixture below serves a one-key roster, which the panel opens on its own
 * — so the assertions can be about the companion rather than about the clicking
 * that reached it.
 */
async function openCompanion(): Promise<void> {
  await screen.findByRole("heading", { name: "Companion" });
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

type Rarity = "common" | "uncommon" | "rare" | "legendary";

type Active = {
  plannedPath: number[];
  stageIndex: number;
  usedAtStage: number;
  rarity: Rarity;
  isShiny: boolean;
  nature: string;
  dittoDisguise: number | null;
  dittoRevealed: boolean;
  everstone: boolean;
  soothe: boolean;
};

type CompanionState = {
  active: Active | null;
  eggUsage: number;
  eggTier: Rarity | null;
  inventory: Record<string, number>;
};

type ShopEntry = { kind: "item"; item: string } | { kind: "egg"; tier: Rarity | null };

/** Mirrors what `GET /keys/:id` actually sends, field for field. */
type DexCatch = {
  id: string;
  /** The line this individual walked — on the catch, because Eevee branches. */
  chainOrder: number[];
  isShiny: boolean;
  nature: string | null;
  caughtAt: number;
};

type DexSpecies = {
  speciesId: number;
  rarity: Rarity;
  /** True when any individual of this species was shiny. */
  isShiny: boolean;
  firstCaughtAt: number;
  catches: DexCatch[];
  /** Resolved from the plugin's own cache, so null on a cold one. */
  name: string | null;
};

type CompanionView = {
  state: CompanionState | null;
  tokensTotal: number;
  wallet: number;
  lastCreditAt: number | null;
  /** What the current stage is called, or null when the cache cannot say. */
  name: string | null;
  dex: DexSpecies[];
  shop: Array<{ entry: ShopEntry; price: number }>;
  nextThreshold: number;
  progress: number;
};

function active(patch: Partial<Active> = {}): Active {
  return {
    plannedPath: [172, 25, 26],
    stageIndex: 1,
    usedAtStage: 4_000,
    rarity: "rare",
    isShiny: false,
    nature: "brave",
    dittoDisguise: null,
    dittoRevealed: false,
    everstone: false,
    soothe: false,
    ...patch,
  };
}

function dexCatch(patch: Partial<DexCatch> = {}): DexCatch {
  return {
    id: "c0",
    chainOrder: [10, 11, 12],
    isShiny: false,
    nature: "timid",
    // Distinct from every id and species number in the fixture, so a row that
    // renders the wrong field is visible rather than coincidentally right.
    caughtAt: 1_700_000_000_777,
    ...patch,
  };
}

function dexSpecies(patch: Partial<DexSpecies> = {}): DexSpecies {
  return {
    speciesId: 12,
    rarity: "common",
    isShiny: false,
    // Distinct from every catch date below, so a cell printing the wrong one is
    // visible. A species with two catches gets neither of these by default —
    // the tests that care set all three.
    firstCaughtAt: 1_700_000_000_111,
    catches: [dexCatch()],
    // Unnamed by default, which is the cold cache and the offline install. The
    // tests that care about names set one; every other assertion in this file
    // is about the species number and stays true either way.
    name: null,
    ...patch,
  };
}

function view(patch: Partial<CompanionView> = {}): CompanionView {
  return {
    state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
    tokensTotal: 0,
    wallet: 0,
    // Null rather than an instant: the default fixture has no active companion,
    // and a companion is what an activity state describes.
    lastCreditAt: null,
    name: null,
    dex: [],
    shop: [],
    // Distinct from every other number in the fixture, so a component that
    // renders the wrong one is visible rather than coincidentally right.
    nextThreshold: 5_000_000,
    progress: 1_240_000,
    ...patch,
  };
}

/** One roster card, as `GET /keys` sends it. */
type RosterKey = {
  apiKeyId: string;
  speciesId: number | null;
  name: string | null;
  rarity: Rarity | null;
  isShiny: boolean;
  tokensTotal: number;
  wallet: number;
  lastCreditAt: number | null;
  unreadable: boolean;
};

const KEY = "key_7f3a";
const GET_ROSTER = "GET /api/plugins/pokemon/keys";
const GET_KEY = `GET /api/plugins/pokemon/keys/${KEY}`;
const POST_PURCHASE = `POST /api/plugins/pokemon/keys/${KEY}/purchase`;
const POST_USE = `POST /api/plugins/pokemon/keys/${KEY}/use`;

function rosterKey(patch: Partial<RosterKey> = {}): RosterKey {
  return {
    apiKeyId: KEY,
    speciesId: 25,
    name: "Pikachu",
    rarity: "rare",
    isShiny: false,
    tokensTotal: 4_200_000,
    wallet: 2_500,
    lastCreditAt: null,
    unreadable: false,
    ...patch,
  };
}

/**
 * The whole panel for one key: the roster it opens on, and the key itself.
 *
 * One key, so the panel opens straight onto the companion. That is the common
 * install — most gateways have a handful of keys and one that does the work —
 * and it means every fixture below tests the companion rather than the clicking.
 */
function serving(body: CompanionView): Record<string, StubHandler> {
  return {
    [GET_ROSTER]: () => ({ body: { keys: [rosterKey()] } }),
    [GET_KEY]: () => ({ body }),
  };
}

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("the key roster", () => {
  /** A roster of several keys, so nothing is opened automatically. */
  function withKeys(keys: RosterKey[], body: CompanionView = view()): Record<string, StubHandler> {
    return {
      [GET_ROSTER]: () => ({ body: { keys } }),
      [GET_KEY]: () => ({ body }),
    };
  }

  test("opens on the keys that have companions, rather than on an empty field", async () => {
    // The complaint this whole surface answers: the panel used to demand a key
    // id, and nothing in the console shows the ids of keys that have
    // companions. An operator had to read them out of the database.
    renderCompanion(
      withKeys([
        rosterKey({ apiKeyId: "key_a", name: "Pikachu", tokensTotal: 4_200_000 }),
        rosterKey({ apiKeyId: "key_b", name: "Snorlax", tokensTotal: 900_000 }),
      ]),
    );

    expect(await screen.findByRole("button", { name: /key_a/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /key_b/ })).toBeTruthy();
    expect(screen.getByText("Pikachu")).toBeTruthy();
    expect(screen.getByText("Snorlax")).toBeTruthy();
  });

  test("opens the companion of the key that was picked", async () => {
    const stub = renderCompanion(
      withKeys(
        [rosterKey({ apiKeyId: "key_other", name: "Snorlax" }), rosterKey({ apiKeyId: KEY })],
        view({ tokensTotal: 12 }),
      ),
    );

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(KEY) }));

    await openCompanion();
    expect(stub.calls.map((call) => call.url)).toEqual([
      "/api/plugins/pokemon/keys",
      `/api/plugins/pokemon/keys/${KEY}`,
    ]);
  });

  test("skips the roster entirely when there is only one key to pick", async () => {
    // A picker offering one choice is a click asked for nothing. Most installs
    // have exactly one key doing the work.
    const stub = renderCompanion(serving(view({ tokensTotal: 12 })));

    await openCompanion();
    expect(screen.queryByRole("button", { name: new RegExp(KEY) })).toBeNull();
    expect(stub.calls.map((call) => call.url)).toEqual([
      "/api/plugins/pokemon/keys",
      `/api/plugins/pokemon/keys/${KEY}`,
    ]);
  });

  test("goes back to the roster from a companion", async () => {
    renderCompanion(
      withKeys([
        rosterKey({ apiKeyId: "key_other", name: "Snorlax" }),
        rosterKey({ apiKeyId: KEY }),
      ]),
    );

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(KEY) }));
    await openCompanion();
    await userEvent.click(screen.getByRole("button", { name: "All keys" }));

    expect(await screen.findByRole("button", { name: /key_other/ })).toBeTruthy();
  });

  test("can leave a key the panel opened by itself", async () => {
    // This asserted the opposite until the auto-open was fixed, on the theory
    // that returning to a roster of one would be undone immediately. It would
    // have been — that was the bug. Now the roster stays put once it has been
    // returned to, which makes the picker reachable, which matters because the
    // key-id field lives there: on a one-key install this is the only route to
    // a key too new to have a companion row, and that is exactly the key the
    // roster cannot list.
    renderCompanion(serving(view()));

    await openCompanion();
    await userEvent.click(screen.getByRole("button", { name: "All keys" }));

    expect(await screen.findByRole("textbox", { name: "API key id" })).toBeTruthy();
    // And it stayed: the single key on the roster did not pull the panel back in.
    expect(screen.queryByRole("heading", { name: "Egg" })).toBeNull();
  });

  test("stays on the companion when a second key appears on the roster", async () => {
    // The panel opened this key by itself, and "opened by itself" used to be
    // stored as "nothing has been chosen" — so the moment the roster stopped
    // having exactly one key, the same expression that opened the companion
    // closed it again. A purchase refetches the roster, so an operator buying a
    // rare candy on a one-key install was one new key away from being thrown
    // back to the picker mid-transaction.
    let rosterKeys = [rosterKey()];
    renderCompanion({
      [GET_ROSTER]: () => ({ body: { keys: rosterKeys } }),
      [GET_KEY]: () => ({
        body: view({ wallet: 500, shop: [{ entry: { kind: "item", item: "mint" }, price: 100 }] }),
      }),
      [POST_PURCHASE]: () => {
        // A second key earns its first tokens while the panel is open.
        rosterKeys = [rosterKey(), rosterKey({ apiKeyId: "key_new", name: "Snorlax" })];
        return { body: {} };
      },
    });

    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "Buy mint" }));

    // Still here. The roster grew underneath, which is not a navigation.
    expect(await screen.findByRole("heading", { name: "Egg" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /key_new/ })).toBeNull();
  });

  test("stays on the roster after going back, even if it shrinks to one key", async () => {
    // The mirror of the case above, and the reason the two states have to be
    // told apart: "go back" is a decision, and a roster that later happens to
    // hold one key must not overturn it.
    let rosterKeys = [rosterKey(), rosterKey({ apiKeyId: "key_other", name: "Snorlax" })];
    renderCompanion({
      [GET_ROSTER]: () => ({ body: { keys: rosterKeys } }),
      [GET_KEY]: () => ({
        body: view({ wallet: 500, shop: [{ entry: { kind: "item", item: "mint" }, price: 100 }] }),
      }),
      [POST_PURCHASE]: () => {
        rosterKeys = [rosterKey()];
        return { body: {} };
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(KEY) }));
    await openCompanion();
    // Shrinks the roster to one key behind the panel's back.
    await userEvent.click(await screen.findByRole("button", { name: "Buy mint" }));
    await userEvent.click(await screen.findByRole("button", { name: "All keys" }));

    expect(await screen.findByRole("textbox", { name: "API key id" })).toBeTruthy();
  });

  test("lets a key reached by id be left again", async () => {
    // The trap this closes: the way back was offered only when the roster held
    // more than one key, so an operator whose roster was empty or unreachable
    // typed an id, arrived, and had no way to look up a second key short of
    // reloading the console. The roster is exactly the thing that is missing in
    // that case, so keying the control off its length was backwards.
    renderCompanion({
      [GET_ROSTER]: () => ({ body: { keys: [] } }),
      [GET_KEY]: () => ({ body: view({ tokensTotal: 12 }) }),
    });

    await lookUp(KEY);
    await openCompanion();
    await userEvent.click(screen.getByRole("button", { name: "All keys" }));

    expect(await screen.findByRole("textbox", { name: "API key id" })).toBeTruthy();
  });

  test("says an empty roster is empty, and explains what fills it", async () => {
    // Not an error. A fresh install has this state, and a companion appears on
    // a key's first request rather than when the key is minted.
    renderCompanion({ [GET_ROSTER]: () => ({ body: { keys: [] } }) });

    expect(await screen.findByText(/No key has spent a token yet/)).toBeTruthy();
  });

  test("falls back to the field when the roster cannot be reached", async () => {
    // A half-registered backend, or a gateway too old to serve the route. The
    // companion is still reachable by id, so the panel degrades to what it used
    // to be rather than showing nothing at all.
    renderCompanion({
      [GET_ROSTER]: () => ({ status: 501, body: { error: { code: "INTERNAL", message: "no" } } }),
      [GET_KEY]: () => ({ body: view({ tokensTotal: 12 }) }),
    });

    await lookUp(KEY);
    await openCompanion();
  });

  test("names a species by number when the cache has no name for it yet", async () => {
    // The cold-cache case reaches the roster too, and a card that said "null"
    // under a sprite would be the first thing an operator saw on a fresh
    // install.
    renderCompanion(
      withKeys([
        rosterKey({ apiKeyId: "key_a", name: null, speciesId: 25 }),
        rosterKey({ apiKeyId: "key_b", name: "Snorlax" }),
      ]),
    );

    expect(await screen.findByText("#25")).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });

  test("draws an egg for a key whose companion has not hatched", async () => {
    renderCompanion(
      withKeys([
        rosterKey({ apiKeyId: "key_a", speciesId: null, name: null, rarity: null }),
        rosterKey({ apiKeyId: "key_b", name: "Snorlax" }),
      ]),
    );

    expect(await screen.findByRole("img", { name: "An egg, not yet hatched" })).toBeTruthy();
  });

  test("lists a key whose save cannot be read, and says that is what it is", async () => {
    // The key an operator most needs to find. Leaving it off the roster is how
    // a corrupt companion stays invisible.
    renderCompanion(
      withKeys([
        rosterKey({ apiKeyId: "key_broken", unreadable: true, speciesId: null, name: null }),
        rosterKey({ apiKeyId: "key_b", name: "Snorlax" }),
      ]),
    );

    expect(await screen.findByRole("button", { name: /key_broken/ })).toBeTruthy();
    expect(screen.getByText("Save unreadable")).toBeTruthy();
  });
});

describe("a save that could not be read", () => {
  test("says so, and does not offer a fresh egg in its place", async () => {
    // The most load-bearing test in the file. "Unreadable" and "not started yet"
    // are different facts all the way down the plugin, and this panel is the last
    // place the distinction can be lost — silently, and in the direction that
    // tells an operator everything is fine.
    renderCompanion(serving(view({ state: null, tokensTotal: 900_000, wallet: 40 })));
    await openCompanion();

    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/left untouched rather than replaced/)).toBeTruthy();

    // Nothing that would read as a companion that simply has not hatched.
    expect(screen.queryByRole("img", { name: "An egg, not yet hatched" })).toBeNull();
    expect(screen.queryByText(/tokens incubated/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Shop" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Pokédex" })).toBeNull();
  });
});

describe("an egg", () => {
  test("renders as an egg with the tokens incubated so far", async () => {
    // Every number here is distinct on purpose. Incubated, earned and spendable
    // are three different quantities the panel reads from three different
    // fields, and a fixture that gives them one value passes whichever two the
    // component confuses.
    renderCompanion(
      serving(
        view({
          // `eggUsage` and `progress` are deliberately different. The panel reads
          // the server-computed `progress`, and with both set to the same number
          // a component that read the wrong one would look correct.
          state: { active: null, eggUsage: 7_777_777, eggTier: null, inventory: {} },
          progress: 1_240_000,
          nextThreshold: 5_000_000,
          tokensTotal: 9_000_000,
          wallet: 2_500,
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("img", { name: "An egg, not yet hatched" })).toBeTruthy();
    expect(screen.getByText("1.2M / 5.0M tokens incubated")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Egg" })).toBeTruthy();

    // Three quantities, three labelled cells. Run together in one sentence they
    // read as one fact about tokens, and an operator deciding whether to buy a
    // rare candy is looking for exactly one of them.
    expect(screen.getByText("Earned").nextSibling?.textContent).toBe("9.0M");
    expect(screen.getByText("To spend").nextSibling?.textContent).toBe("2,500");
    expect(screen.getByText("Graduated").nextSibling?.textContent).toBe("0");
  });

  test("names the tier a guaranteed egg was bought at", async () => {
    renderCompanion(
      serving(view({ state: { active: null, eggUsage: 0, eggTier: "rare", inventory: {} } })),
    );
    await openCompanion();

    // The guarantee is a property of the egg, so it sits beside it as a chip
    // rather than inside the heading. An egg is an egg however it was bought.
    expect(await screen.findByRole("heading", { name: "Egg" })).toBeTruthy();
    expect(screen.getByText("rare+ guaranteed")).toBeTruthy();
  });
});

describe("an active companion", () => {
  test("shows its stage, its rarity and a sprite that names the species", async () => {
    renderCompanion(
      serving(
        view({
          state: {
            active: active(),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await openCompanion();

    // The sprite is the current stage of the planned path, not its first or last.
    const sprite = await screen.findByRole("img", { name: "Species 25" });
    expect(sprite.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/25");

    expect(screen.getByText("Stage 2 of 3")).toBeTruthy();
    expect(screen.getByText("rare")).toBeTruthy();
    expect(screen.getByText("brave")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "An egg, not yet hatched" })).toBeNull();
  });

  test("calls the companion by name once the cache has one, behind its number", async () => {
    // The number is what the panel could always say. The name is what an
    // operator recognises, and it is a fact the plugin already had on disk and
    // was throwing away. Both, now, in the order a Pokédex prints them — and
    // the heading's accessible name is the concatenation, which is what makes
    // this assertion the real one rather than two `getByText` calls that would
    // pass with the number rendered anywhere on the panel.
    renderCompanion(
      serving(
        view({
          name: "Pikachu",
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("heading", { name: "#25 Pikachu" })).toBeTruthy();
    // The sprite keeps the bare name. An alt is read aloud in a sentence, and
    // the number belongs to the heading rather than to what the picture is of.
    expect(screen.getByRole("img", { name: "Pikachu" })).toBeTruthy();
  });

  test("falls back to the species number when the cache has no name", async () => {
    renderCompanion(
      serving(
        view({
          name: null,
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
        }),
      ),
    );
    await openCompanion();

    // `#25`, once. The number now has a slot of its own, so an unresolved name
    // must leave that slot empty rather than filling it with the number again.
    expect(await screen.findByRole("heading", { name: "#25" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "null" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "#25 #25" })).toBeNull();
  });

  test("gives an egg no species number, because it has no species yet", async () => {
    // The one case where the number is not merely unresolved but absent: a
    // species is not rolled until an egg hatches, so a `#` beside "Egg" would
    // be the panel inventing a fact the save does not hold.
    renderCompanion(
      serving(
        view({
          name: null,
          state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("heading", { name: "Egg" })).toBeTruthy();
  });

  test("draws the whole evolution line, with growth on the stage it is standing at", async () => {
    // The one thing on the panel that is not a number or a label: the planned
    // path is three species long and the companion is on the second, so there
    // are three segments and the progress belongs to the middle one. A single
    // bar could not say how far through the *line* a companion is, which is the
    // question an operator watching one grow actually has.
    renderCompanion(
      serving(
        view({
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
          progress: 1_240_000,
          nextThreshold: 5_000_000,
        }),
      ),
    );
    await openCompanion();

    const track = await screen.findByRole("progressbar", { name: "Growth to the next evolution" });
    expect(track.getAttribute("aria-valuenow")).toBe("1240000");
    expect(track.getAttribute("aria-valuemax")).toBe("5000000");
    expect(track.getAttribute("aria-valuetext")).toBe("stage 2 of 3, 1.2M of 5.0M tokens");
  });

  test("an incubating egg has one segment, because it has no line yet", async () => {
    // An egg's planned path is not rolled until it hatches. Drawing three empty
    // segments would be inventing a line the save does not have.
    renderCompanion(
      serving(
        view({
          state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
          progress: 1_240_000,
          nextThreshold: 5_000_000,
        }),
      ),
    );
    await openCompanion();

    const track = await screen.findByRole("progressbar", { name: "Incubation" });
    expect(track.getAttribute("aria-valuetext")).toBe("1.2M of 5.0M tokens incubated");
  });

  test("says a shiny is shiny, in the sprite's name as well as the line", async () => {
    renderCompanion(
      serving(
        view({
          state: {
            active: active({ isShiny: true }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await openCompanion();

    const sprite = await screen.findByRole("img", { name: "Species 25, shiny" });
    expect(sprite.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/25?shiny=1");
    // Said in words, not carried by a colour. The console's rule is that colour
    // means provider identity or state, and shininess is neither — so the mark
    // beside it is a glyph and the word is what makes it legible.
    expect(screen.getByText("shiny")).toBeTruthy();
    expect(screen.getByText("rare")).toBeTruthy();
  });

  test("hints that a disguised companion is not what it looks like", async () => {
    renderCompanion(
      serving(
        view({
          state: {
            active: active({ dittoDisguise: 172, dittoRevealed: false }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await openCompanion();
    await screen.findByRole("img", { name: "Species 25" });

    expect(screen.getByText("?")).toBeTruthy();
  });

  test("does not offer an egg while one is already incubating", async () => {
    // An egg is a reroll. With nothing to reroll the server refuses it, so
    // offering the button would be offering a guaranteed 409 — and buying it
    // used to destroy the incubation outright.
    renderCompanion(
      serving(
        view({
          state: { active: null, eggUsage: 4_000_000, eggTier: null, inventory: {} },
          wallet: 9_000_000_000,
          shop: [
            { entry: { kind: "egg", tier: null }, price: 1_000_000_000 },
            { entry: { kind: "item", item: "rareCandy" }, price: 500_000_000 },
          ],
        }),
      ),
    );
    await openCompanion();

    const egg = await screen.findByRole("button", { name: /fresh egg/ });
    expect(egg.hasAttribute("disabled")).toBe(true);
    // Everything else is still for sale, wallet permitting.
    expect(screen.getByRole("button", { name: /rare candy/ }).hasAttribute("disabled")).toBe(false);
  });

  test("offers an egg once there is a companion to replace", async () => {
    renderCompanion(
      serving(
        view({
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
          wallet: 9_000_000_000,
          shop: [{ entry: { kind: "egg", tier: null }, price: 1_000_000_000 }],
        }),
      ),
    );
    await openCompanion();

    const egg = await screen.findByRole("button", { name: /fresh egg/ });
    expect(egg.hasAttribute("disabled")).toBe(false);
  });

  test("marks a passive already owned instead of offering to buy it twice", async () => {
    // Owning the charm *is* its effect, so a second one is 3B for nothing. The
    // server refuses it; this keeps the panel from offering a guaranteed 409.
    renderCompanion(
      serving(
        view({
          state: {
            active: active(),
            eggUsage: 0,
            eggTier: null,
            inventory: { shinyCharm: 1 },
          },
          wallet: 9_000_000_000,
          shop: [
            { entry: { kind: "item", item: "shinyCharm" }, price: 3_000_000_000 },
            { entry: { kind: "item", item: "rareCandy" }, price: 500_000_000 },
          ],
        }),
      ),
    );
    await openCompanion();

    const charm = await screen.findByRole("button", { name: "Buy shiny charm" });
    expect(charm.hasAttribute("disabled")).toBe(true);
    // The price is replaced rather than sat beside: a price on something that
    // cannot be bought is the one number on the card that means nothing.
    expect(screen.getByText("owned")).toBeTruthy();
    expect(screen.queryByText("3.0B")).toBeNull();

    // And a spendable item is untouched by the rule, wallet permitting — its
    // price is still on show, which is what makes the charm's absence a
    // decision rather than a shop that prices nothing.
    const candy = screen.getByRole("button", { name: "Buy rare candy" });
    expect(candy.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("500.0M")).toBeTruthy();
  });

  test("says a pinned companion is held rather than showing it stuck", async () => {
    // A pinned companion's progress runs past its threshold and keeps going, so
    // the usual "X / Y to the next stage" would read as a number stuck above a
    // line it should already have crossed — which is how a deliberate state gets
    // diagnosed as a broken one.
    renderCompanion(
      serving(
        view({
          state: {
            active: active({ everstone: true }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
          progress: 9_000_000,
          nextThreshold: 5_000_000,
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText(/Held at this stage/)).toBeTruthy();
    expect(screen.queryByText(/to the next stage/)).toBeNull();
    expect(screen.getByText("everstone")).toBeTruthy();
  });

  test("offers to release a pinned companion and asks the route that spends nothing", async () => {
    const stub = renderCompanion({
      ...serving(
        view({
          state: {
            active: active({ everstone: true }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
      [`POST /api/plugins/pokemon/keys/${KEY}/unpin`]: () => ({ body: { ok: true } }),
    });
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: "Release" }));

    // The unpin route, not `use`: releasing through the item path would need a
    // spare stone in hand and would spend it.
    expect(
      stub.calls.some((call) => call.method === "POST" && call.url.endsWith(`/keys/${KEY}/unpin`)),
    ).toBe(true);
  });

  test("offers no release control when nothing is pinned", async () => {
    renderCompanion(
      serving(view({ state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} } })),
    );
    await openCompanion();
    await screen.findByRole("img", { name: "Species 25" });

    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  test("stops hinting once the disguise has dropped", async () => {
    // `dittoDisguise` stays set after a reveal — it records what this one was
    // pretending to be — so a hint keyed on it alone would mark a revealed Ditto
    // as still hiding something for the rest of its life.
    renderCompanion(
      serving(
        view({
          state: {
            active: active({ dittoDisguise: 172, dittoRevealed: true }),
            eggUsage: 0,
            eggTier: null,
            inventory: {},
          },
        }),
      ),
    );
    await openCompanion();
    await screen.findByRole("img", { name: "Species 25" });

    expect(screen.queryByText("?")).toBeNull();
  });
});

describe("the shop", () => {
  const shop = [
    { entry: { kind: "item", item: "rareCandy" } as const, price: 100 },
    { entry: { kind: "egg", tier: "rare" } as const, price: 101 },
  ];

  test("disables an offer the wallet cannot afford and enables one it exactly can", async () => {
    renderCompanion(serving(view({ wallet: 100, shop })));
    await openCompanion();

    // The label is derived, so the accessible name is the assertion: an operator
    // reads "rare candy", not the field name it was stored under. The tier is in
    // the egg's name for a reason — three egg offers share one heading, and a
    // chip is not part of a button's accessible name.
    const affordable = await screen.findByRole("button", { name: "Buy rare candy" });
    const tooDear = screen.getByRole("button", { name: "Buy fresh egg (rare+)" });

    // Exactly affordable is affordable — the boundary, not a round number.
    expect((affordable as HTMLButtonElement).disabled).toBe(false);
    expect((tooDear as HTMLButtonElement).disabled).toBe(true);
  });

  test("posts the entry itself when an affordable offer is bought", async () => {
    const stub = renderCompanion({
      ...serving(view({ wallet: 100, shop })),
      [POST_PURCHASE]: () => ({ body: {} }),
    });
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: "Buy rare candy" }));

    const posted = stub.calls.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`/api/plugins/pokemon/keys/${KEY}/purchase`);
    expect(JSON.parse(posted[0]?.body ?? "null")).toEqual({ kind: "item", item: "rareCandy" });
  });

  test("does not post when the offer the wallet cannot afford is clicked", async () => {
    const stub = renderCompanion({
      ...serving(view({ wallet: 100, shop })),
      [POST_PURCHASE]: () => ({ body: {} }),
    });
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: "Buy fresh egg (rare+)" }));

    expect(stub.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("says what an item does, not only what it costs", async () => {
    // The complaint the cards answer. `rare candy · 500.0M` named a thing and
    // priced it and said nothing about what buying it would do, so the shop was
    // readable only by somebody who already knew the economy.
    //
    // Every quantity here is distinct — a wallet that could afford either, and
    // two prices that are not each other — so a card rendering the wrong number
    // fails rather than passing by coincidence.
    renderCompanion(
      serving(
        view({
          wallet: 9_000_000_000,
          shop: [
            { entry: { kind: "item", item: "rareCandy" }, price: 500_000_000 },
            { entry: { kind: "egg", tier: "uncommon" }, price: 2_500_000_000 },
          ],
        }),
      ),
    );
    await openCompanion();

    expect(
      await screen.findByText("Injects 100.0M growth. Priced at five times what it grants."),
    ).toBeTruthy();
    expect(screen.getByText("500.0M")).toBeTruthy();

    // The egg's guarantee reads in the sentence as well as in the chip, because
    // a chip is not part of anything a screen reader announces for the button.
    expect(
      screen.getByText(
        "Sends this companion off for an egg guaranteed to hatch uncommon or better.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("2.50B")).toBeTruthy();
  });

  test("keeps offering an unknown item after one has been bought", async () => {
    // The two sides of "can this be spent" have to be one fact. The bag reads
    // `itemCard(...).consumable`, which is `true` for an unknown item on
    // purpose — a visible refusal from the server beats a button the panel
    // never draws. `alreadyOwned` read `CONSUMABLE_ITEMS` instead, which is
    // built only from the ids the catalogue knows, so it called the same item
    // passive and greyed its offer out for good once one was held.
    //
    // A stackable item the server ships before anybody writes its copy would
    // then be usable from the bag and unbuyable from the shop, with the price
    // replaced by the word "owned" — the silent omission the fallback exists to
    // avoid, arriving on the other surface.
    renderCompanion(
      serving(
        view({
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: { quickClaw: 1 } },
          wallet: 9_000_000_000,
          shop: [{ entry: { kind: "item", item: "quickClaw" }, price: 700_000_000 }],
        }),
      ),
    );
    await openCompanion();

    const buy = (await screen.findByRole("button", {
      name: "Buy quick claw",
    })) as HTMLButtonElement;
    expect(buy.disabled).toBe(false);
    expect(screen.getByText("700.0M")).toBeTruthy();
    expect(screen.queryByText("owned")).toBeNull();
  });

  test("still offers an item nobody has written a description for", async () => {
    // Copy fails open. An item the server sells that the catalogue has never
    // heard of keeps its row, its derived name and a working Buy button — a
    // missing sentence is not a missing item, and a shop that dropped an offer
    // over unwritten copy would hide something an operator can actually buy.
    renderCompanion(
      serving(
        view({
          wallet: 9_000_000_000,
          shop: [{ entry: { kind: "item", item: "quickClaw" }, price: 700_000_000 }],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText("quick claw")).toBeTruthy();
    expect(screen.getByText("700.0M")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Buy quick claw" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("the Pokédex", () => {
  test("says it is empty rather than drawing an empty grid", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await openCompanion();

    expect(await screen.findByText("Nothing caught yet.")).toBeTruthy();
    // The egg is the only image on the panel: no stray cells, no placeholders.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("names each species by rarity, shininess and species", async () => {
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({ speciesId: 3, rarity: "common" }),
            dexSpecies({ speciesId: 134, rarity: "legendary", isShiny: true }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("Nothing caught yet.")).toBeNull();
  });

  test("draws each cell's own species, at its own shininess", async () => {
    // `alt` and `src` are two separate expressions in the cell and only the alt
    // was ever asserted, so a cell could have been drawing some other field
    // entirely with every assertion still green. Two species, one shiny.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({ speciesId: 12 }),
            dexSpecies({ speciesId: 134, rarity: "legendary", isShiny: true }),
          ],
        }),
      ),
    );
    await openCompanion();

    const plain = await screen.findByRole("img", { name: "common species 12" });
    expect(plain.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/12");

    const shiny = screen.getByRole("img", { name: "legendary shiny species 134" });
    expect(shiny.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/134?shiny=1");
  });

  test("collects a pre-evolution as its own cell", async () => {
    // The whole feature, seen from the panel. A graduated Venusaur puts three
    // species in the collection and the grid draws three cells, in number
    // order — not one cell for the graduate with the rest folded away.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({ speciesId: 1, name: "Bulbasaur" }),
            dexSpecies({ speciesId: 2, name: "Ivysaur" }),
            dexSpecies({ speciesId: 3, name: "Venusaur" }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("img", { name: "common Bulbasaur" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common Ivysaur" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common Venusaur" })).toBeTruthy();
  });

  test("numbers every cell, whether or not the species has a name yet", async () => {
    // The number is the one identifier a species always has: `name` is filled
    // in by a cache that starts cold, so a grid captioned by name alone is a
    // grid of anonymous sprites on a fresh install. Two species, only one
    // named, because the number has to survive sitting beside a resolved name
    // rather than only standing in for a missing one.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({ speciesId: 134, name: "Vaporeon", rarity: "legendary" }),
            dexSpecies({ speciesId: 3, name: null }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText("#134")).toBeTruthy();
    expect(screen.getByText("Vaporeon")).toBeTruthy();
    // Exactly one `#3`: the number is its own line, so an unnamed cell must not
    // also print the number where its name would have gone.
    expect(screen.getAllByText("#3")).toHaveLength(1);
  });

  test("counts a species caught more than once, and says nothing about one caught once", async () => {
    // A count that is always there stops being information, which is why `× 1`
    // is suppressed. Two species so the suppression is visible beside a count
    // rather than only in isolation.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({
              speciesId: 3,
              catches: [
                dexCatch({ id: "c1", caughtAt: 1_700_000_008_000 }),
                dexCatch({ id: "c2", caughtAt: 1_700_000_002_000 }),
              ],
            }),
            dexSpecies({ speciesId: 26, catches: [dexCatch({ id: "c3" })] }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText("× 2")).toBeTruthy();
    expect(screen.queryByText("× 1")).toBeNull();
  });

  test("marks a species shiny with a glyph, alongside its count", async () => {
    // A glyph and not a colour: the panel's rule reserves colour for provider
    // identity and state, and shininess is neither.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({
              speciesId: 3,
              isShiny: true,
              catches: [
                dexCatch({ id: "c1", isShiny: true, caughtAt: 1_700_000_008_000 }),
                dexCatch({ id: "c2", isShiny: false, caughtAt: 1_700_000_002_000 }),
              ],
            }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText("✦ × 2")).toBeTruthy();
  });

  test("keeps nature off the cell, because a cell is a species", async () => {
    // Nature belongs to an individual. Two catches with different natures, and
    // neither may appear until the record is opened — a cell that printed one
    // would be claiming a species has a temperament.
    renderCompanion(
      serving(
        view({
          dex: [
            dexSpecies({
              speciesId: 3,
              catches: [
                dexCatch({ id: "c1", nature: "modest", caughtAt: 1_700_000_008_000 }),
                dexCatch({ id: "c2", nature: "adamant", caughtAt: 1_700_000_002_000 }),
              ],
            }),
          ],
        }),
      ),
    );
    await openCompanion();
    await screen.findByRole("img", { name: "common species 3" });

    expect(screen.queryByText("modest")).toBeNull();
    expect(screen.queryByText("adamant")).toBeNull();
  });
});

describe("a Pokédex record", () => {
  /** The Venusaur line, all three stages named, one catch through it. */
  const line = [
    dexSpecies({
      speciesId: 1,
      name: "Bulbasaur",
      catches: [dexCatch({ id: "c1", chainOrder: [1, 2, 3] })],
    }),
    dexSpecies({
      speciesId: 2,
      name: "Ivysaur",
      catches: [dexCatch({ id: "c1", chainOrder: [1, 2, 3] })],
    }),
    dexSpecies({
      speciesId: 3,
      name: "Venusaur",
      catches: [dexCatch({ id: "c1", chainOrder: [1, 2, 3], nature: "relaxed" })],
    }),
  ];

  async function openRecord(dex: DexSpecies[], name: string) {
    renderCompanion(serving(view({ dex })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  }

  test("captions every stage of the evolution line with both number and name", async () => {
    // The bug this feature exists to fix. The detail used to caption the stage
    // matching `final_id` with a name and every other stage with a bare number,
    // so a Venusaur's line read `#1 → #2 → Venusaur`. That was not a cold cache
    // — no name was ever resolved for a non-final stage — so it was permanent,
    // and it read as a rendering fault rather than as missing data.
    await openRecord(line, "Venusaur");

    expect(screen.getByText("#1 Bulbasaur")).toBeTruthy();
    expect(screen.getByText("#2 Ivysaur")).toBeTruthy();
    expect(screen.getByText("#3 Venusaur")).toBeTruthy();
    // And the record's own title says both too, asserted through the heading's
    // accessible name — which is the concatenation of its two slots, and so is
    // a stronger claim than two `getByText` calls that would pass with the
    // number rendered anywhere on the panel.
    expect(screen.getByRole("heading", { name: "#3 Venusaur" })).toBeTruthy();
  });

  test("falls back to the number alone for a stage the cache cannot name yet", async () => {
    // A cold cache is an ordinary state, not an error. The middle stage is
    // unnamed and its neighbours are not, because a fallback has to survive
    // sitting between two resolved names.
    const partial = [
      line[0] as DexSpecies,
      dexSpecies({
        speciesId: 2,
        name: null,
        catches: [dexCatch({ id: "c1", chainOrder: [1, 2, 3] })],
      }),
      line[2] as DexSpecies,
    ];
    await openRecord(partial, "Venusaur");

    expect(screen.getByText("#1 Bulbasaur")).toBeTruthy();
    // Twice on the page and both are wanted: the unnamed species has a cell of
    // its own on the grid, and the line has a caption for it. What matters is
    // that both say the number and nothing else.
    expect(screen.getAllByText("#2")).toHaveLength(2);
    // Never the record's name borrowed onto a stage that is not it, and never
    // the number standing in for a name it does not have.
    expect(screen.queryByText("#2 Venusaur")).toBeNull();
    expect(screen.queryByText("#2 #2")).toBeNull();
  });

  test("names a stage the current filter has hidden", async () => {
    // The name index has to be built from the whole collection rather than
    // from what is on screen. Eevee is common and Vaporeon is legendary, so
    // filtering to legendary takes Eevee off the grid — and its name with it,
    // if the index were built from the filtered list. The line would then read
    // `#133 → #134 Vaporeon` for as long as the filter was on.
    const eeveeLine = [
      dexSpecies({
        speciesId: 133,
        name: "Eevee",
        rarity: "common",
        catches: [dexCatch({ id: "c1", chainOrder: [133, 134] })],
      }),
      dexSpecies({
        speciesId: 134,
        name: "Vaporeon",
        rarity: "legendary",
        catches: [dexCatch({ id: "c1", chainOrder: [133, 134] })],
      }),
    ];
    renderCompanion(serving(view({ dex: eeveeLine })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "legendary" }));
    await userEvent.click(screen.getByRole("button", { name: /Vaporeon/ }));

    expect(screen.getByText("#133 Eevee")).toBeTruthy();
  });

  test("draws one line per branch a species was caught through", async () => {
    // Eevee. Its chain branches, so one Eevee record can hold a Vaporeon catch
    // and a Jolteon catch. A single line on the record would have to pick a
    // winner and would print "Eevee → Vaporeon" over a Jolteon the player owns.
    const branched = [
      dexSpecies({
        speciesId: 133,
        name: "Eevee",
        catches: [
          dexCatch({ id: "c1", chainOrder: [133, 134], caughtAt: 1_700_000_008_000 }),
          dexCatch({ id: "c2", chainOrder: [133, 135], caughtAt: 1_700_000_002_000 }),
        ],
      }),
      dexSpecies({
        speciesId: 134,
        name: "Vaporeon",
        catches: [dexCatch({ id: "c1", chainOrder: [133, 134] })],
      }),
      dexSpecies({
        speciesId: 135,
        name: "Jolteon",
        catches: [dexCatch({ id: "c2", chainOrder: [133, 135] })],
      }),
    ];
    await openRecord(branched, "Eevee");

    expect(screen.getByText("#134 Vaporeon")).toBeTruthy();
    expect(screen.getByText("#135 Jolteon")).toBeTruthy();
    // Eevee heads both lines, so its caption appears once per line.
    expect(screen.getAllByText("#133 Eevee")).toHaveLength(2);
  });

  test("draws one line when two catches walked the same one", async () => {
    // The common case, and the one a naive per-catch loop gets wrong: two
    // Venusaur graduations are two catches through one line, and drawing it
    // twice would read as a branch that does not exist.
    const twice = [
      dexSpecies({
        speciesId: 3,
        name: "Venusaur",
        catches: [
          dexCatch({ id: "c1", chainOrder: [1, 2, 3], caughtAt: 1_700_000_008_000 }),
          dexCatch({ id: "c2", chainOrder: [1, 2, 3], caughtAt: 1_700_000_002_000 }),
        ],
      }),
    ];
    await openRecord(twice, "Venusaur");

    // Once, in the single line — not once per catch.
    expect(screen.getAllByText("#3 Venusaur")).toHaveLength(1);
  });

  test("lists every catch with its own nature", async () => {
    // Distinct natures, because one would pass against a record that printed
    // the first catch's nature on every row.
    const twice = [
      dexSpecies({
        speciesId: 3,
        name: "Venusaur",
        catches: [
          dexCatch({ id: "c1", nature: "modest", caughtAt: 1_700_000_008_000 }),
          dexCatch({ id: "c2", nature: "adamant", caughtAt: 1_700_000_002_000 }),
        ],
      }),
    ];
    await openRecord(twice, "Venusaur");

    expect(screen.getByText(/modest/)).toBeTruthy();
    expect(screen.getByText(/adamant/)).toBeTruthy();
  });

  test("omits the nature of a catch recorded before natures were stored", async () => {
    // Nullable in the store, so the record has to survive it without printing
    // "null" in a history row.
    await openRecord(
      [
        dexSpecies({
          speciesId: 3,
          name: "Venusaur",
          catches: [dexCatch({ id: "c1", nature: null })],
        }),
      ],
      "Venusaur",
    );

    expect(screen.queryByText(/null/)).toBeNull();
  });

  test("dates the species from its first catch, not its latest", async () => {
    // "First caught" is the fact a Pokédex records, and the server sends it as
    // its own field rather than leaving the panel to infer it from the list.
    // The date here is deliberately earlier than either catch, so a record that
    // derived it from `catches` instead of reading the field fails.
    await openRecord(
      [
        dexSpecies({
          speciesId: 3,
          name: "Venusaur",
          firstCaughtAt: Date.UTC(2024, 0, 15),
          catches: [
            dexCatch({ id: "c1", caughtAt: Date.UTC(2026, 5, 1) }),
            dexCatch({ id: "c2", caughtAt: Date.UTC(2025, 2, 9) }),
          ],
        }),
      ],
      "Venusaur",
    );

    expect(
      screen.getByText(`first caught ${new Date(Date.UTC(2024, 0, 15)).toLocaleDateString()}`),
    ).toBeTruthy();
  });

  test("dates each catch from its own instant", async () => {
    // The history rows carry a date each and nothing asserted them, so a record
    // that printed `firstCaughtAt` on every row — or dropped the date from the
    // row entirely — passed the whole suite. Three distinct days, none of them
    // shared with the first-caught date, so a row showing the wrong one is
    // visible rather than coincidentally right.
    await openRecord(
      [
        dexSpecies({
          speciesId: 3,
          name: "Venusaur",
          firstCaughtAt: Date.UTC(2024, 0, 15),
          catches: [
            dexCatch({ id: "c1", nature: "modest", caughtAt: Date.UTC(2026, 5, 1) }),
            dexCatch({ id: "c2", nature: "adamant", caughtAt: Date.UTC(2025, 2, 9) }),
          ],
        }),
      ],
      "Venusaur",
    );

    const newest = new Date(Date.UTC(2026, 5, 1)).toLocaleDateString();
    const oldest = new Date(Date.UTC(2025, 2, 9)).toLocaleDateString();
    // Each date beside its own catch's nature, which is what makes this an
    // assertion about the row rather than about the page.
    expect(screen.getByText(`${newest} · modest`)).toBeTruthy();
    expect(screen.getByText(`${oldest} · adamant`)).toBeTruthy();
  });
});

describe("the Dex rarity filter", () => {
  /** One of each rarity, each with a species number found nowhere else. */
  const mixed = [
    dexSpecies({ speciesId: 3, rarity: "common" }),
    dexSpecies({ speciesId: 26, rarity: "rare" }),
    dexSpecies({ speciesId: 134, rarity: "legendary", isShiny: true }),
  ];

  test("shows every species until a rarity is chosen", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();

    expect(await screen.findByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "rare species 26" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
  });

  test("filtering to common excludes uncommon, which contains the word", async () => {
    // The one pair of rarities that no other fixture holds at the same time, and
    // the reason this test exists: `"uncommon".includes("common")` is true, so a
    // predicate written with `includes` instead of `===` passes every other test
    // in this file — `mixed` has no uncommon entry, and nothing else ever filters
    // to `common`. That mutation survived a full run before this was added.
    //
    // Its own fixture rather than an entry appended to `mixed`, because the
    // filtered-empty test below depends on `uncommon` being absent from that one.
    const pair = [
      dexSpecies({ speciesId: 3, rarity: "common" }),
      dexSpecies({ speciesId: 12, rarity: "uncommon" }),
    ];
    renderCompanion(serving(view({ dex: pair })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "common" }));

    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "uncommon species 12" })).toBeNull();
  });

  test("narrows to the chosen rarity and hides the rest", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "legendary" }));

    expect(screen.getByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "common species 3" })).toBeNull();
    expect(screen.queryByRole("img", { name: "rare species 26" })).toBeNull();
  });

  test("says which filter is on, rather than only showing it", async () => {
    // The grid alone cannot answer "why am I seeing three of two hundred" for
    // somebody who arrived at the panel after the click.
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "rare" }));

    expect(screen.getByRole("button", { name: "rare", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "all", pressed: false })).toBeTruthy();
  });

  test("goes back to everything when the filter is cleared", async () => {
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "legendary" }));
    await userEvent.click(screen.getByRole("button", { name: "all" }));

    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "rare species 26" })).toBeTruthy();
  });

  test("says the filter is empty rather than claiming nothing has been caught", async () => {
    // The two facts a shared empty state would merge. An operator who has 200
    // species and filters to a rarity they have never caught must not be told
    // their collection is empty — that reads as a bug in the panel.
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "uncommon" }));

    expect(screen.getByText("No uncommon species yet.")).toBeTruthy();
    expect(screen.queryByText("Nothing caught yet.")).toBeNull();
    // The egg is the only image left: the grid is gone, not merely emptied of
    // matches while keeping placeholder cells.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("offers no filter at all when nothing has been caught", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await openCompanion();

    expect(await screen.findByText("Nothing caught yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "legendary" })).toBeNull();
  });
});

describe("the bag", () => {
  /** A state with an inventory, and a companion for a candy to grow. */
  function withInventory(inventory: Record<string, number>): CompanionView {
    return view({
      state: { active: active(), eggUsage: 0, eggTier: null, inventory },
      lastCreditAt: null,
    });
  }

  test("lists what is held, with its count", async () => {
    // Distinct counts. Two items sharing one would pass against a component
    // that printed the first item's count beside every name.
    renderCompanion(serving(withInventory({ rareCandy: 3, mint: 7 })));
    await openCompanion();

    // Name and count are separate elements now — the count sits where the shop
    // puts a price — so they are asserted separately. Distinct values are what
    // makes that safe: a card printing the wrong item's count still fails.
    expect(await screen.findByText("rare candy")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByText("mint")).toBeTruthy();
    expect(screen.getByText("×7")).toBeTruthy();
  });

  test("spends a held item through the route that was written for it", async () => {
    // The dead end this closes: `POST keys/:id/use` existed and nothing in the
    // console called it, so a candy granted at a rate-limit ceiling could be
    // counted and never spent.
    const stub = renderCompanion({
      ...serving(withInventory({ rareCandy: 2 })),
      [POST_USE]: () => ({ body: { ok: true } }),
    });
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: "Use rare candy" }));

    const posted = stub.calls.filter((call) => call.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`/api/plugins/pokemon/keys/${KEY}/use`);
    expect(JSON.parse(posted[0]?.body ?? "null")).toEqual({ item: "rareCandy" });
  });

  test("refetches the panel after a use, so the count it shows is the new one", async () => {
    let candies = 2;
    const stub = renderCompanion({
      [GET_ROSTER]: () => ({ body: { keys: [rosterKey()] } }),
      [GET_KEY]: () => ({ body: withInventory({ rareCandy: candies }) }),
      [POST_USE]: () => {
        candies -= 1;
        return { body: { ok: true } };
      },
    });
    await openCompanion();

    expect(await screen.findByText("×2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use rare candy" }));

    expect(await screen.findByText("×1")).toBeTruthy();
    // Twice for this key: once on open, once because the use invalidated it.
    // Counted per route, since the roster is fetched on mount as well.
    expect(
      stub.calls.filter((call) => call.url === `/api/plugins/pokemon/keys/${KEY}`),
    ).toHaveLength(2);
  });

  test("shows a refusal rather than a panel that silently looks unchanged", async () => {
    const stub = renderCompanion({
      ...serving(withInventory({ rareCandy: 1 })),
      [POST_USE]: () => ({
        status: 409,
        body: { error: { code: "CONFLICT", message: "none-held" } },
      }),
    });
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: "Use rare candy" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("none-held")).toBeTruthy();
    // Refused, so the companion was not refetched: the alert is the whole
    // outcome. Counted per route rather than across every GET, because the
    // panel also fetches the roster once on mount.
    expect(
      stub.calls.filter((call) => call.url === `/api/plugins/pokemon/keys/${KEY}`),
    ).toHaveLength(1);
  });

  test("offers no way to spend the charm, which the server would refuse anyway", async () => {
    // `parseHeldItem` admits `rareCandy` and `mint` only, so a POST of
    // `shinyCharm` is a 400. A button here would be a button whose only
    // possible outcome is an error.
    renderCompanion(serving(withInventory({ shinyCharm: 1, mint: 4 })));
    await openCompanion();

    expect(await screen.findByText("shiny charm")).toBeTruthy();
    expect(screen.getByText("×1")).toBeTruthy();
    expect(screen.getByText("held")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use shiny charm" })).toBeNull();
    // And the consumable beside it still has one, so this is not a bag with no
    // buttons at all.
    expect(screen.getByRole("button", { name: "Use mint" })).toBeTruthy();
  });

  test("does not offer an item held zero times", async () => {
    // `freshState` writes every item at zero, so an unfiltered bag lists the
    // whole catalogue as if it were owned.
    renderCompanion(serving(withInventory({ mint: 5 })));
    await openCompanion();

    expect(await screen.findByText("mint")).toBeTruthy();
    expect(screen.getByText("×5")).toBeTruthy();
    expect(screen.queryByText(/rare candy/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use rare candy" })).toBeNull();
  });

  test("says the bag is empty when nothing is held", async () => {
    renderCompanion(serving(withInventory({})));
    await openCompanion();

    expect(await screen.findByText("Nothing in the bag.")).toBeTruthy();
  });
});

describe("the folding sections", () => {
  function withEverything(): CompanionView {
    // Distinct counts, so a heading that reports the wrong section's total is
    // visible rather than coincidentally right.
    return view({
      state: {
        active: active(),
        eggUsage: 0,
        eggTier: null,
        inventory: { rareCandy: 3, mint: 7 },
      },
      shop: [{ entry: { kind: "item", item: "mint" }, price: 100 }],
      dex: [
        dexSpecies({ speciesId: 10 }),
        dexSpecies({ speciesId: 11 }),
        dexSpecies({ speciesId: 12 }),
      ],
    });
  }

  test("says what each section holds without being opened", async () => {
    // The whole reason a folded heading is more than a word. "BAG" tells an
    // operator nothing they did not already know.
    renderCompanion(serving(withEverything()));
    await openCompanion();

    expect(await screen.findByText("1 offer")).toBeTruthy();
    expect(screen.getByText("2 held")).toBeTruthy();
    // "species" and not "speciess": the one irregular noun on this panel.
    expect(screen.getByText("3 species")).toBeTruthy();
  });

  test("folds a section away and says so", async () => {
    renderCompanion(serving(withEverything()));
    await openCompanion();

    const bag = await screen.findByRole("button", { name: /Bag/ });
    expect(bag.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Use mint" })).toBeTruthy();

    await userEvent.click(bag);

    expect(bag.getAttribute("aria-expanded")).toBe("false");
    // Unmounted rather than hidden: a hidden subtree is still reachable by a
    // keyboard, which is a section that folds for the eye and not for the hand.
    expect(screen.queryByRole("button", { name: "Use mint" })).toBeNull();
    // And the count survives the fold, which is what makes folding cheap.
    expect(screen.getByText("2 held")).toBeTruthy();
  });

  test("remembers what was folded, and folds only that", async () => {
    const { unmount } = renderCompanion(serving(withEverything()));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: /Bag/ }));
    unmount();

    renderCompanion(serving(withEverything()));
    await openCompanion();

    expect((await screen.findByRole("button", { name: /Bag/ })).getAttribute("aria-expanded")).toBe(
      "false",
    );
    // The other two are untouched, so this is a remembered choice rather than a
    // panel that reopens folded.
    expect(screen.getByRole("button", { name: /Shop/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Pokédex/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  test("still folds when the browser refuses to remember anything", async () => {
    // Storage disabled by policy, a quota error, a sandboxed frame. Persistence
    // is a convenience and must not be able to take the panel down.
    const realSetItem = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error("storage is disabled");
    };
    try {
      renderCompanion(serving(withEverything()));
      await openCompanion();

      const bag = await screen.findByRole("button", { name: /Bag/ });
      await userEvent.click(bag);
      expect(bag.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "Use mint" })).toBeNull();
    } finally {
      globalThis.localStorage.setItem = realSetItem;
    }
  });

  test("ignores a remembered value that is not a state this panel has", async () => {
    // Hand-edited storage, or a value from an older version of the panel. Each
    // key is narrowed on its own, so a junk `shop` does not take `bag` with it.
    globalThis.localStorage.setItem(
      "plugin:pokemon:sections",
      JSON.stringify({ shop: "yes", bag: false }),
    );
    renderCompanion(serving(withEverything()));
    await openCompanion();

    expect(
      (await screen.findByRole("button", { name: /Shop/ })).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /Bag/ }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("an item icon", () => {
  test("falls back to a glyph when there is no sprite to draw", async () => {
    // One path for three absences: `mint`, which has no sprite in the PokéAPI
    // repository at all; a cold cache, where every icon 404s on first paint;
    // and an offline install, where the route answers 503 forever. The panel
    // cannot tell them apart and does not need to.
    //
    // happy-dom has no image loader, so it fires `error` on every `img` as soon
    // as one is attached — which means the fallback is what this environment can
    // observe, and the loaded state is not testable here at all. That is a
    // limitation of the renderer rather than a claim about browsers, and it is
    // why `itemSpriteUrl` is asserted separately below: the two halves of this
    // component are "ask for the right thing" and "cope when it is not there",
    // and only the second one survives a DOM without a network.
    renderCompanion(
      serving(view({ wallet: 500, shop: [{ entry: { kind: "item", item: "mint" }, price: 100 }] })),
    );
    await openCompanion();

    expect(await screen.findByText("🌿")).toBeTruthy();
    // Replaced, not covered: an image left in the tree is one still asking the
    // gateway for a sprite that is never coming.
    expect(document.querySelector('img[src*="item-sprite"]')).toBeNull();
  });

  test("asks the plugin's own mount for the icon, under the item's stored id", async () => {
    // No renderer: this is the URL the component builds, and it is the half of
    // the icon a DOM without a network cannot exercise. The stored id is the
    // segment because the server's sprite map is keyed by it — a label like
    // "rare candy" would 404 on every item whose name has a space.
    expect(itemSpriteUrl("pokemon", "rareCandy")).toBe(
      "/api/plugins/pokemon/item-sprite/rareCandy",
    );
    // Every egg tier shares one icon: the guarantee is a fact about the offer,
    // carried by the chip, not by the artwork.
    expect(itemSpriteUrl("pokemon", "egg")).toBe("/api/plugins/pokemon/item-sprite/egg");
  });
});

describe("an incubating egg", () => {
  test("asks for the incubating sprite, not the shop's egg icon", async () => {
    // The "ask for the right thing" half, asserted without a renderer for the
    // reason the item icon's URL test is: happy-dom fires `error` on every
    // `img` the moment it attaches, so the loaded state cannot be observed here
    // at all and only the fallback survives.
    //
    // Two keys and not one, deliberately. `egg` is the 32px icon on a shop card
    // beside a price; `incubating` is the 192px figure of a companion that has
    // not hatched. Collapsing them would draw the offer and the thing it
    // produces identically.
    // `eggSpriteUrl` and not `itemSpriteUrl("incubating")`: asserting the latter
    // would only prove the URL builder concatenates, which it already has a
    // test for. This is the function `EggSprite` actually calls, so a rename of
    // the sprite key cannot pass here and 404 in the panel.
    expect(eggSpriteUrl("pokemon")).toBe("/api/plugins/pokemon/item-sprite/incubating");
    expect(eggSpriteUrl("pokemon")).not.toBe(itemSpriteUrl("pokemon", "egg"));
  });

  test("falls back to the drawn mark, keeping the name a reader hears", async () => {
    // The "cope when it is not there" half, and it covers the two absences that
    // matter: a cold cache, where the route 404s on first paint and fills in on
    // a later poll, and an install without `net`, where it answers 503 and no
    // art is ever coming. An unhatched companion must never be a broken-image
    // icon — that is the failure the drawn mark existed for in the first place.
    renderCompanion(
      serving(view({ state: { active: null, eggUsage: 0, eggTier: null, inventory: {} } })),
    );
    await openCompanion();

    // The accessible name is unchanged whichever branch renders, so a screen
    // reader cannot tell that the artwork moved.
    expect(await screen.findByRole("img", { name: "An egg, not yet hatched" })).toBeTruthy();
    // Replaced, not covered: an image left in the tree is one still asking the
    // gateway for a sprite that is never coming.
    expect(document.querySelector('img[src*="item-sprite/incubating"]')).toBeNull();
  });

  test("an unreadable save on the roster is still not an egg", async () => {
    // The guard, and the one confusion this plugin refuses to make anywhere.
    // Giving the egg real artwork must not tempt the roster into drawing a save
    // it could not read as a companion that merely has not hatched — both are
    // `speciesId: null`, so the only thing keeping them apart is the branch
    // order in `KeyPicker`.
    // Two keys, so the panel stays on the roster instead of opening the only
    // one — and the hatched second key is what proves the assertion below is
    // about the broken card rather than about an empty screen.
    renderCompanion({
      [GET_ROSTER]: () => ({
        body: {
          keys: [
            rosterKey({ apiKeyId: "key_broken", unreadable: true, speciesId: null, name: null }),
            rosterKey({ apiKeyId: "key_b", name: "Snorlax" }),
          ],
        },
      }),
      [GET_KEY]: () => ({ body: view() }),
    });

    expect(await screen.findByText("Save unreadable")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "An egg, not yet hatched" })).toBeNull();
  });
});

describe("a Dex record opened", () => {
  /** Raichu, caught once through the Pichu line, with no stage before it named. */
  const raichu = dexSpecies({
    speciesId: 26,
    rarity: "rare",
    name: "Raichu",
    catches: [dexCatch({ id: "c1", chainOrder: [172, 25, 26], nature: "brave" })],
  });

  test("shows the record the grid has no room for", async () => {
    renderCompanion(serving(view({ dex: [raichu] })));
    await openCompanion();

    const cell = await screen.findByRole("button", { name: /Raichu/ });
    expect(cell.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(cell);

    expect(cell.getAttribute("aria-expanded")).toBe("true");
    // The whole line, not only the form it graduated as. Neither earlier stage
    // is in this fixture's collection, so neither has a name and both fall back
    // to a bare number — the same fallback the grid uses.
    expect(screen.getByText("#172")).toBeTruthy();
    expect(screen.getByText("#25")).toBeTruthy();
    // The nature reads once now rather than twice: it left the cell when a cell
    // became a species, so the catch list is the only place it appears. "rare"
    // still reads twice, because it is also the name of a filter button.
    expect(screen.getAllByText(/brave/)).toHaveLength(1);
    expect(screen.getAllByText("rare")).toHaveLength(2);
  });

  test("closes when the same record is clicked again", async () => {
    renderCompanion(serving(view({ dex: [raichu] })));
    await openCompanion();

    const cell = await screen.findByRole("button", { name: /Raichu/ });
    await userEvent.click(cell);
    expect(screen.getByText("#172")).toBeTruthy();

    await userEvent.click(cell);
    expect(cell.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("#172")).toBeNull();
  });

  test("closes when a filter could take the open record off the grid", async () => {
    // A detail panel describing a sprite that is no longer on screen is the
    // same class of lie as a bag listing something it does not hold — and worse
    // here, because it would sit under a grid of unrelated Pokémon looking like
    // one of theirs.
    renderCompanion(
      serving(
        view({
          dex: [raichu, dexSpecies({ speciesId: 19, rarity: "common", name: "Rattata" })],
        }),
      ),
    );
    await openCompanion();

    await userEvent.click(await screen.findByRole("button", { name: /Raichu/ }));
    expect(screen.getByText("#172")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "common" }));

    expect(screen.queryByText("#172")).toBeNull();
    expect(screen.queryByText(/brave/)).toBeNull();
  });
});

describe("the Dex grid's identity", () => {
  test("keeps a cell alive when the grid reorders underneath it", async () => {
    // The cells carry a key, which reads as though reordering is handled — but
    // each `.map` used to return a bare ARRAY of [cell, detail], and React
    // reconciles unkeyed nested arrays as implicit fragments matched by
    // POSITION. The outer index became part of the identity, so every cell
    // unmounted and remounted on any reorder: every sprite destroyed and
    // refetched, and the focused cell losing focus mid-keyboard-navigation.
    //
    // The collection arrives sorted by number, so a reorder is now a species
    // appearing rather than the whole list resequencing — which is a smaller
    // shift and exactly as capable of remounting a positionally-keyed grid.
    //
    // Rendered directly rather than through the panel: the panel would need a
    // poll to reorder anything, and focus identity is the assertion.
    const a = dexSpecies({ speciesId: 3, name: "Venusaur" });
    const b = dexSpecies({ speciesId: 6, name: "Charizard" });
    const c = dexSpecies({ speciesId: 9, name: "Blastoise" });

    const { rerender } = render(<Dex entries={[b, c]} pluginId="pokemon" />);
    const before = screen.getByRole("button", { name: /Charizard/ });
    before.focus();
    expect(document.activeElement).toBe(before);

    // A lower-numbered species is collected and takes the front of the grid.
    rerender(<Dex entries={[a, b, c]} pluginId="pokemon" />);

    const after = screen.getByRole("button", { name: /Charizard/ });
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
  });

  test("captions a stage from its own species, never from the record it is under", async () => {
    // The bug this replaces went the other way: the detail named whichever
    // stage matched `final_id` and numbered the rest, so it could print the
    // graduate's name under a sprite that was not the graduate. Naming each
    // stage from its own id cannot make that mistake — but only if the lookup
    // is by species and not by position, which is what this pins.
    //
    // Vaporeon is the record; Eevee is the stage before it and has its own
    // name. A caption resolved by position would put "Vaporeon" under Eevee.
    const eevee = dexSpecies({
      speciesId: 133,
      name: "Eevee",
      catches: [dexCatch({ id: "c1", chainOrder: [133, 134] })],
    });
    const vaporeon = dexSpecies({
      speciesId: 134,
      name: "Vaporeon",
      catches: [dexCatch({ id: "c1", chainOrder: [133, 134] })],
    });
    render(<Dex entries={[eevee, vaporeon]} pluginId="pokemon" />);

    await userEvent.click(screen.getByRole("button", { name: /Vaporeon/ }));

    expect(screen.getByText("#133 Eevee")).toBeTruthy();
    expect(screen.queryByText("#133 Vaporeon")).toBeNull();
  });
});

describe("the activity state", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  /** A companion that last earned `ago` milliseconds before now. */
  function earning(ago: number | null): CompanionView {
    return view({
      state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
      lastCreditAt: ago === null ? null : Date.now() - ago,
    });
  }

  test("puts each boundary on the side the spec names", async () => {
    // Asserted against the derivation rather than through a render, and that is
    // deliberate. The panel reads the wall clock, so a fixture pinned one
    // millisecond inside a band has already left it by the time React has
    // painted — the earlier version of this table failed about half the time
    // for that reason alone. Here `now` is a parameter, so the edges are exact.
    const NOW = 1_700_000_000_000;
    const at = (ago: number): string => activityOf(true, NOW - ago, NOW);

    expect(at(0)).toBe("working");
    expect(at(5 * MINUTE - 1)).toBe("working");
    expect(at(5 * MINUTE)).toBe("idle");
    expect(at(HOUR - 1)).toBe("idle");
    expect(at(HOUR)).toBe("tired");
    expect(at(8 * HOUR - 1)).toBe("tired");
    expect(at(8 * HOUR)).toBe("sleep");

    // Never observed earning, and no companion at all. Both are ordering rules
    // rather than bands, so neither has an edge to sample.
    expect(activityOf(true, null, NOW)).toBe("sleep");
    expect(activityOf(false, NOW, NOW)).toBe("egg");
  });

  const cases: ReadonlyArray<{ ago: number | null; state: string }> = [
    // Mid-band, one per state: what the rendered panel has to say. The edges
    // are the pure test above; these prove the derivation reaches the DOM.
    { ago: 0, state: "working" },
    { ago: 30 * MINUTE, state: "idle" },
    { ago: 3 * HOUR, state: "tired" },
    { ago: 40 * HOUR, state: "sleep" },
    // A save written before the column existed.
    { ago: null, state: "sleep" },
  ];

  for (const { ago, state } of cases) {
    test(`reads ${ago === null ? "never" : `${ago}ms`} since the last credit as ${state}`, async () => {
      renderCompanion(serving(earning(ago)));
      await openCompanion();

      // The name and the visible text both, because the rule is that the state
      // is legible without colour — not merely announced.
      expect(await screen.findByRole("status", { name: `Activity: ${state}` })).toBeTruthy();
      expect(screen.getByText(state)).toBeTruthy();

      // The spec lists six states. `focus` would have to mean a burst of recent
      // requests, and the plugin keeps one instant per key rather than any
      // per-request history, so there is nothing here that could tell a burst
      // from a trickle. Asserted in every band so that inventing it later fails
      // wherever it was made to fire.
      expect(screen.queryByText("focus")).toBeNull();
    });
  }

  test("an unhatched companion is an egg however recently the key earned", async () => {
    // Ordering, not a band: an egg has no activity to describe, so the freshest
    // possible credit must not make one "working".
    renderCompanion(
      serving(
        view({
          state: { active: null, eggUsage: 0, eggTier: null, inventory: {} },
          lastCreditAt: Date.now(),
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("status", { name: "Activity: egg" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Activity: working" })).toBeNull();
  });
});

describe("a request that fails", () => {
  // Reached through the fallback field on purpose: a key the roster cannot
  // offer is exactly the key an operator types an id for, and the roster in
  // these fixtures is unreachable too.
  test("renders a message instead of throwing into the host's error boundary", async () => {
    renderCompanion({
      [GET_ROSTER]: () => ({ body: { keys: [] } }),
      [GET_KEY]: () => ({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "no such key" } },
      }),
    });
    await lookUp(KEY);

    expect(await screen.findByText("No companion for that key yet.")).toBeTruthy();
  });

  test("survives a route the gateway does not serve at all", async () => {
    // The stub's 501, which is what a mistyped prefix or a half-registered
    // plugin backend looks like from the panel's side — for the roster and for
    // the companion both.
    renderCompanion({});
    await lookUp(KEY);

    expect(await screen.findByText("No companion for that key yet.")).toBeTruthy();
  });
});

/**
 * A control standing in for the console's chassis bar.
 *
 * The panel has no switch of its own — that is the point of the feature — so
 * the only way to observe it *reacting* is to render something beside it that
 * toggles the shared context, which is exactly what the chassis does.
 */
function PauseButton() {
  // Inside the provider, necessarily. A `useLive` above its own `LiveProvider`
  // gets the no-provider fallback, whose `toggle` does nothing — and a control
  // that silently does nothing would make the test below pass for the wrong
  // reason in one direction and fail inexplicably in the other.
  const { toggle } = useLive();
  return (
    <button onClick={toggle} type="button">
      pause
    </button>
  );
}

function Chassis({ children }: { children: ReactNode }) {
  return (
    <LiveProvider>
      <PauseButton />
      {children}
    </LiveProvider>
  );
}

describe("the console's LIVE switch", () => {
  /**
   * The test the rest of this block was missing, and the reason it is first.
   *
   * Everything below observes a context that never changes, and a panel that
   * read the switch once at mount and ignored it forever passed all of it —
   * 79 of 79 green while the feature this whole change exists for did nothing.
   * An operator hitting LIVE mid-session is the entire scenario, so it is the
   * one that has to be watched happening rather than sampled at rest.
   */
  test("both queries stop when the console is paused, and start again", async () => {
    const { client } = renderCompanion(
      serving(view({ state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} } })),
      { chassis: true },
    );
    await openCompanion();

    expect(intervalOf(client, ["roster"])).toBe(10_000);
    expect(intervalOf(client, ["companion", KEY])).toBe(10_000);

    await userEvent.click(screen.getByRole("button", { name: "pause" }));

    expect(intervalOf(client, ["roster"])).toBe(false);
    expect(intervalOf(client, ["companion", KEY])).toBe(false);

    // Back again, because a pause an operator cannot undo is a different bug
    // from one that never happens.
    await userEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(intervalOf(client, ["roster"])).toBe(10_000);
    expect(intervalOf(client, ["companion", KEY])).toBe(10_000);
  });

  /**
   * Both queries, because the roster is the one that did not poll at all before
   * and is the easier of the two to leave behind — the companion already had an
   * interval, so a change that only reached it would look finished.
   *
   * This one cannot tell `cadence(REFETCH_MS)` from a bare `REFETCH_MS`: while
   * the console is live `cadence(x)` *is* `x`. What it pins is the constant's
   * value. The wiring is the test above.
   */
  test("polls at the console's own cadence, not a figure of its own", async () => {
    const { client } = renderCompanion(
      serving(view({ state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} } })),
      { live: true },
    );
    await openCompanion();

    expect(intervalOf(client, ["roster"])).toBe(10_000);
    expect(intervalOf(client, ["companion", KEY])).toBe(10_000);
  });

  /**
   * The case an operator actually causes, and the case this panel gets in every
   * other test in this file.
   *
   * `false`, not `0` and not `undefined`: react-query reads `0` as "as fast as
   * possible", so a `cadence` that returned the wrong falsy value would turn a
   * pause into a flood against the gateway the operator was trying to quieten.
   */
  test("stops polling when there is no live console above it", async () => {
    const { client, calls } = renderCompanion(
      serving(view({ state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} } })),
    );
    await openCompanion();

    expect(intervalOf(client, ["roster"])).toBe(false);
    expect(intervalOf(client, ["companion", KEY])).toBe(false);
    // And the panel still worked: paused means not refetching, never not
    // fetching. An operator who pauses still sees the companion they opened.
    expect(calls.filter((call) => call.url.endsWith(`/keys/${KEY}`))).toHaveLength(1);
  });
});
