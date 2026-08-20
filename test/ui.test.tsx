/**
 * The companion panel, rendered.
 *
 * Run by `bun run test:plugins`, not by the root suite — `bunfig.toml` excludes
 * it there. The reason is the DOM: registering one mutates process-wide globals,
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
import { createPluginApi } from "@omnigateway/dashboard-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import companionUi, { activityOf } from "../ui/index.tsx";

const Companion = companionUi.mount;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* the harness                                                                 */
/* -------------------------------------------------------------------------- */

type StubResponse = { status?: number; body?: unknown };

type StubHandler = (input: { url: string; body: string | undefined }) => StubResponse;

type FetchStub = {
  calls: Array<{ method: string; url: string; body: string | undefined }>;
};

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
 */
function renderCompanion(routes: Record<string, StubHandler>): FetchStub {
  const stub = stubFetch(routes);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Companion api={createPluginApi("pokemon")} pluginId="pokemon" />
    </QueryClientProvider>,
  );
  return stub;
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
type DexEntry = {
  id: string;
  baseId: number;
  finalId: number;
  chainOrder: number[];
  rarity: Rarity;
  isShiny: boolean;
  nature: string | null;
  caughtAt: number;
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
  dex: DexEntry[];
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

function dexEntry(patch: Partial<DexEntry> = {}): DexEntry {
  return {
    id: "d0",
    baseId: 10,
    finalId: 12,
    chainOrder: [10, 11, 12],
    rarity: "common",
    isShiny: false,
    nature: "timid",
    // Distinct from every id and species number in the fixture, so a cell that
    // renders the wrong field is visible rather than coincidentally right.
    caughtAt: 1_700_000_000_777,
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
    await userEvent.click(await screen.findByRole("button", { name: "mint · 100" }));

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
    await userEvent.click(await screen.findByRole("button", { name: "mint · 100" }));
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

  test("calls the companion by name once the cache has one", async () => {
    // The number is what the panel could always say. The name is what an
    // operator recognises, and it is a fact the plugin already had on disk and
    // was throwing away.
    renderCompanion(
      serving(
        view({
          name: "Pikachu",
          state: { active: active(), eggUsage: 0, eggTier: null, inventory: {} },
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("heading", { name: "Pikachu" })).toBeTruthy();
    // And the sprite is named the same way, rather than keeping the number in
    // its alt text while the heading says something else.
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

    expect(await screen.findByRole("heading", { name: "#25" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "null" })).toBeNull();
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

    const charm = await screen.findByRole("button", { name: /shiny charm/ });
    expect(charm.hasAttribute("disabled")).toBe(true);
    // The price is replaced rather than sat beside: a price on something that
    // cannot be bought is the one number on the row that means nothing.
    expect(charm.textContent).toContain("owned");
    expect(charm.textContent).not.toContain("3.0B");

    // And a spendable item is untouched by the rule, wallet permitting.
    const candy = screen.getByRole("button", { name: /rare candy/ });
    expect(candy.hasAttribute("disabled")).toBe(false);
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
    // reads "rare candy", not the field name it was stored under.
    const affordable = await screen.findByRole("button", { name: "rare candy · 100" });
    const tooDear = screen.getByRole("button", { name: "fresh egg (rare+) · 101" });

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

    await userEvent.click(await screen.findByRole("button", { name: "rare candy · 100" }));

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

    await userEvent.click(await screen.findByRole("button", { name: "fresh egg (rare+) · 101" }));

    expect(stub.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("the Pokédex", () => {
  test("says it is empty rather than drawing an empty grid", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await openCompanion();

    expect(await screen.findByText("Nothing graduated yet.")).toBeTruthy();
    // The egg is the only image on the panel: no stray cells, no placeholders.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("names each graduate by rarity, shininess and species", async () => {
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({
              id: "d1",
              baseId: 133,
              finalId: 134,
              chainOrder: [133, 134],
              rarity: "legendary",
              isShiny: true,
              nature: "modest",
            }),
            dexEntry({
              id: "d2",
              baseId: 1,
              finalId: 3,
              chainOrder: [1, 2, 3],
              rarity: "common",
              nature: "adamant",
            }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("img", { name: "legendary shiny species 134" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("Nothing graduated yet.")).toBeNull();
  });

  test("draws the graduate itself, not the form it started as", async () => {
    // `alt` and `src` are two separate expressions in the cell and only the alt
    // was ever asserted — so every thumbnail could have been built from
    // `entry.baseId` and the whole collection would have rendered its
    // pre-evolutions, with 37 UI tests green and the alt text still naming the
    // right species.
    //
    // `baseId` and `finalId` differ in both fixtures, which is the only reason
    // the swap is visible at all: on a one-form line the two URLs are identical.
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({ id: "d1", baseId: 10, finalId: 12, chainOrder: [10, 11, 12] }),
            dexEntry({
              id: "d2",
              baseId: 133,
              finalId: 134,
              chainOrder: [133, 134],
              rarity: "legendary",
              isShiny: true,
              nature: "modest",
            }),
          ],
        }),
      ),
    );
    await openCompanion();

    const graduate = await screen.findByRole("img", { name: "common species 12" });
    expect(graduate.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/12");

    // And the shiny variant is asked for by the entry's own flag, on the final
    // form as well.
    const shiny = screen.getByRole("img", { name: "legendary shiny species 134" });
    expect(shiny.getAttribute("src")).toBe("/api/plugins/pokemon/sprite/134?shiny=1");
  });

  test("shows the nature the server records, which the sprite cannot say", async () => {
    // Two different natures, because one would pass against a component that
    // rendered the same entry twice.
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({ id: "d1", finalId: 134, nature: "modest" }),
            dexEntry({ id: "d2", finalId: 3, nature: "adamant" }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByText("modest")).toBeTruthy();
    expect(screen.getByText("adamant")).toBeTruthy();
  });

  test("names a graduate the way an operator would, and captions it too", async () => {
    // Two entries, only one named: the cold-cache fallback has to survive
    // sitting next to a resolved one, which is the state a filling cache is
    // actually in.
    renderCompanion(
      serving(
        view({
          dex: [
            dexEntry({ id: "d1", finalId: 134, name: "Vaporeon", rarity: "legendary" }),
            dexEntry({ id: "d2", finalId: 3, name: null }),
          ],
        }),
      ),
    );
    await openCompanion();

    expect(await screen.findByRole("img", { name: "legendary Vaporeon" })).toBeTruthy();
    expect(screen.getByText("Vaporeon")).toBeTruthy();
    // The unnamed one keeps the number, in the alt text and under the sprite.
    expect(screen.getByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
  });

  test("omits the nature of an entry recorded before natures were stored", async () => {
    // Nullable in the store, so the cell has to survive it without printing
    // "null" under a sprite.
    renderCompanion(serving(view({ dex: [dexEntry({ id: "d1", finalId: 3, nature: null })] })));
    await openCompanion();

    expect(await screen.findByRole("img", { name: "common species 3" })).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });
});

describe("the Dex rarity filter", () => {
  /** One of each rarity, each with a species number found nowhere else. */
  const mixed = [
    dexEntry({ id: "d1", finalId: 3, rarity: "common", nature: "adamant" }),
    dexEntry({ id: "d2", finalId: 26, rarity: "rare", nature: "brave" }),
    dexEntry({ id: "d3", finalId: 134, rarity: "legendary", isShiny: true, nature: "modest" }),
  ];

  test("shows every graduate until a rarity is chosen", async () => {
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
      dexEntry({ id: "p1", finalId: 3, rarity: "common", nature: "adamant" }),
      dexEntry({ id: "p2", finalId: 12, rarity: "uncommon", nature: "timid" }),
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

  test("says the filter is empty rather than claiming nothing has graduated", async () => {
    // The two facts a shared empty state would merge. An operator who has 200
    // graduates and filters to a rarity they have never caught must not be told
    // their collection is empty — that reads as a bug in the panel.
    renderCompanion(serving(view({ dex: mixed })));
    await openCompanion();
    await userEvent.click(await screen.findByRole("button", { name: "uncommon" }));

    expect(screen.getByText("No uncommon graduates yet.")).toBeTruthy();
    expect(screen.queryByText("Nothing graduated yet.")).toBeNull();
    // The egg is the only image left: the grid is gone, not merely emptied of
    // matches while keeping placeholder cells.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  test("offers no filter at all when nothing has graduated", async () => {
    renderCompanion(serving(view({ dex: [] })));
    await openCompanion();

    expect(await screen.findByText("Nothing graduated yet.")).toBeTruthy();
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

    expect(await screen.findByText("rare candy · 3")).toBeTruthy();
    expect(screen.getByText("mint · 7")).toBeTruthy();
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

    expect(await screen.findByText("rare candy · 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use rare candy" }));

    expect(await screen.findByText("rare candy · 1")).toBeTruthy();
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

    expect(await screen.findByText("shiny charm · 1")).toBeTruthy();
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

    expect(await screen.findByText("mint · 5")).toBeTruthy();
    expect(screen.queryByText(/rare candy/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use rare candy" })).toBeNull();
  });

  test("says the bag is empty when nothing is held", async () => {
    renderCompanion(serving(withInventory({})));
    await openCompanion();

    expect(await screen.findByText("Nothing in the bag.")).toBeTruthy();
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
