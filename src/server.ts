// The `./define` subpath rather than the package root, deliberately. The root
// re-exports the manifest schema and with it zod, which a plugin never needs at
// runtime — importing it bundled half a megabyte of validator into every plugin
// that only wanted an identity function and some types.
import { definePlugin, type PluginContext, type PluginRoute } from "@omnigateway/plugin-api/define";
import type { CompanionEvent } from "./advance.ts";
import {
  EGG_HATCH_THRESHOLD,
  freshEggPrice,
  ITEM_KINDS,
  ITEM_PRICES,
  type ItemKind,
  phaseThreshold,
  RARE_CANDY_XP,
  rarityFromCaptureRate,
} from "./balance.ts";
import { decideGrant, windowKey } from "./grants.ts";
import { cachedSpeciesName, speciesDetail, speciesIndex, spriteBytes } from "./pokeapi.ts";
import { NATURES, roll } from "./roll.ts";
import type { CompanionState } from "./state.ts";
import { hasShinyCharm } from "./state.ts";
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
  type ShopEntry,
  setGrantedAt,
  settle,
  wallet,
} from "./store.ts";

/**
 * How much of a request's tokens count toward growth.
 *
 * Operator-tunable, because the balance was tuned against one laptop and a
 * gateway fronting several clients moves that in an afternoon. Applied at credit
 * time and never retroactively, so changing it never rewrites history or
 * de-evolves anything.
 */
const MAX_MULTIPLIER = 1_000;

function multiplierFrom(config: Readonly<Record<string, unknown>>): number {
  const raw = config.multiplier;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  // Capped rather than trusted. A mistyped 1e21 pushes `tokens_total` past
  // MAX_SAFE_INTEGER, where addition silently stops being addition and the
  // growth meter quietly becomes fiction. A thousand already graduates a
  // legendary in an afternoon, so nothing legitimate is above it.
  return Math.min(raw, MAX_MULTIPLIER);
}

/**
 * A Dex row id.
 *
 * `now` is passed rather than read, like everything else in this plugin — and a
 * counter is mixed in because two graduations can land in the same millisecond
 * when a large credit carries through several lines at once. A primary-key
 * collision would throw *after* `settle` had already written the state back,
 * losing the graduation with nothing to say so.
 */
let dexSequence = 0;
function dexId(
  apiKeyId: string,
  event: Extract<CompanionEvent, { kind: "graduated" }>,
  now: number,
): string {
  dexSequence += 1;
  return `${apiKeyId}:${event.baseId}:${event.finalId}:${now}:${dexSequence}`;
}

export default definePlugin({
  migrations: MIGRATIONS,

  setup(ctx: PluginContext) {
    const storage = ctx.storage;
    const events = ctx.events;
    const net = ctx.net;
    const files = ctx.files;
    // Declared in the manifest, so their absence is a broken install rather than
    // a supported configuration. Failing here is reported by the loader and
    // skips this plugin, which is the right outcome: a companion with no storage
    // is not a degraded companion, it is none.
    if (storage === undefined) throw new Error("the companion needs the storage capability");

    const multiplier = multiplierFrom(ctx.config);

    /**
     * One prefetch at a time, per key.
     *
     * `prefetchHatch` is fired unawaited from the panel route, and building the
     * species index is ~1300 requests against an unpaid public API. Without this
     * every poll of a panel whose egg has no species launches another crawl, and
     * concurrent polls stack — which is a way to be rate-limited by PokéAPI for
     * being impolite rather than for doing anything useful.
     */
    const inFlight = new Map<string, Promise<void>>();
    const prefetchOnce = (apiKeyId: string, state: CompanionState): Promise<void> => {
      const existing = inFlight.get(apiKeyId);
      if (existing !== undefined) return existing;
      const started = prefetchHatch(apiKeyId, state).finally(() => inFlight.delete(apiKeyId));
      inFlight.set(apiKeyId, started);
      return started;
    };

    /**
     * Species names already on disk, held for the life of the process.
     *
     * **Only hits are remembered.** Caching a miss would be the obvious thing
     * and the wrong one: a miss means the species index has not been built yet,
     * which is a state that ends — the prefetch is building it right now — and a
     * remembered `null` would keep the panel showing `#25` until the gateway
     * restarted. A miss costs one absent-file read on the next poll; a
     * remembered miss costs the feature.
     *
     * A name is an immutable fact about a species, so a hit never needs
     * invalidating.
     */
    const names = new Map<number, string>();
    const nameOf = async (speciesId: number | null): Promise<string | null> => {
      if (speciesId === null || files === undefined) return null;
      const known = names.get(speciesId);
      if (known !== undefined) return known;
      const found = await cachedSpeciesName({ files }, speciesId);
      if (found !== null) names.set(speciesId, found);
      return found;
    };

    /**
     * Applies whatever the credited total has earned, and writes any graduation
     * into the Dex.
     *
     * Called on read as well as after a credit. `settle` is idempotent, so the
     * repetition costs a comparison rather than a second helping of growth.
     */
    const settleAndRecord = (apiKeyId: string): void => {
      const result = settle(storage, apiKeyId, ctx.now());
      if (result === null) return;
      for (const event of result.events) {
        if (event.kind !== "graduated") continue;
        recordGraduation(
          storage,
          apiKeyId,
          {
            baseId: event.baseId,
            finalId: event.finalId,
            chainOrder: event.chainOrder,
            rarity: event.rarity,
            isShiny: event.isShiny,
            nature: event.nature,
            caughtAt: ctx.now(),
          },
          dexId(apiKeyId, event, ctx.now()),
        );
        ctx.logger.info("companion graduated", { event: "companion.graduated", count: 1 });
      }
    };

    /**
     * Rolls the next species for an egg that has none.
     *
     * Prefetched while the egg is still incubating, so the hatch itself needs no
     * network. Everything here is best effort: with no index yet the egg simply
     * keeps its progress and tries again later.
     */
    const prefetchHatch = async (apiKeyId: string, state: CompanionState): Promise<void> => {
      if (state.active !== null || state.pendingHatch !== null) return;
      if (net === undefined || files === undefined) return;

      const candidates = await speciesIndex({ net, files });
      if (candidates.length === 0) return;

      const collected = new Set(readDex(storage, apiKeyId).map((entry) => entry.finalId));
      const rolled = roll({
        candidates,
        // Seeded from facts rather than from a clock, so a retried prefetch
        // produces the same Pokémon instead of rerolling until it likes one.
        seed: hashSeed(`${apiKeyId}:${state.consumedTotal}`),
        guarantee: state.eggTier,
        hasShinyCharm: hasShinyCharm(state),
        collectedFinals: collected,
      });
      if (rolled === null) return;

      const detail = await speciesDetail({ net, files }, rolled.speciesId);
      // No detail, no hatch. Defaulting to a one-form common would pick a
      // graduation total from thin air — the same class of invisible wrong guess
      // `parseState` refuses to make — and the egg would carry it for its whole
      // life. Waiting costs a retry on the next poll and nothing else.
      if (detail === null) return;
      const path = detail.chain;
      // Derived here rather than at roll time, and that is what lets a legendary
      // ever be hatched. The candidate index carries capture rates only, so the
      // roll cannot see the legendary flags — the detail can, so a legendary
      // that came through the rare band is recorded as legendary and costs a
      // legendary's graduation rather than a rare's.
      const rarity = rarityFromCaptureRate(
        detail.captureRate,
        detail.isLegendary,
        detail.isMythical,
      );

      const current = readCompanion(storage, apiKeyId);
      // Re-read rather than trusting the state this started from: an await
      // happened in between, and a credit may have landed.
      if (current?.state == null || current.state.pendingHatch !== null) return;

      storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
        JSON.stringify({
          ...current.state,
          pendingHatch: {
            speciesId: rolled.speciesId,
            path,
            rarity,
            isShiny: rolled.isShiny,
            nature: rolled.nature,
            ditto: rolled.ditto,
          },
        }),
        ctx.now(),
        apiKeyId,
      ]);
    };

    if (events?.onRequestCompleted !== undefined) {
      events.onRequestCompleted((event) => {
        const tokens =
          event.tokens.input +
          event.tokens.output +
          event.tokens.cacheRead +
          event.tokens.cacheWrite;
        creditTokens(storage, event.apiKeyId, Math.round(tokens * multiplier), ctx.now());
        settleAndRecord(event.apiKeyId);
      });
    }

    if (events?.onLimitReached !== undefined) {
      events.onLimitReached((event) => {
        const key = windowKey(event);
        const row = readCompanion(storage, event.apiKeyId);
        if (row?.state == null) return;

        const decision = decideGrant({
          window: event.window,
          lastGrantedAt: lastGrantedAt(storage, event.apiKeyId, key),
          now: ctx.now(),
        });

        if (!decision.grant) {
          // Seeding is a write to the grants table alone: the window records
          // that it has been seen, and the companion's own state is untouched.
          if (decision.seedAt !== undefined) {
            setGrantedAt(storage, event.apiKeyId, key, decision.seedAt);
          }
          return;
        }

        setGrantedAt(storage, event.apiKeyId, key, decision.at);
        storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
          JSON.stringify({
            ...row.state,
            inventory: {
              ...row.state.inventory,
              rareCandy: row.state.inventory.rareCandy + decision.count,
            },
          }),
          ctx.now(),
          event.apiKeyId,
        ]);
        ctx.logger.info("companion candy granted", {
          event: "companion.candy",
          count: decision.count,
        });
      });
    }

    const routes: PluginRoute[] = [
      {
        method: "GET",
        path: "/keys",
        /**
         * Every key that has a companion, for the panel to open on.
         *
         * The design said a plugin cannot enumerate API keys, and that is still
         * true — this enumerates the plugin's **own saves**, which is a
         * different set and the one the panel actually wants. A key with no row
         * has never spent a token, so it has no companion to show; listing it
         * would offer an operator a card that leads to a 404.
         *
         * Deliberately *not* settled. A roster is a list of front doors and an
         * operator may have fifty; settling every save on every poll would turn
         * opening the panel into fifty state-machine runs and fifty writes. The
         * key's own route settles it on the way in, which is the moment the
         * numbers are actually looked at.
         */
        handler: async () => {
          const rows = listCompanions(storage);
          const keys = await Promise.all(
            rows.map(async (row) => {
              const active = row.state?.active ?? null;
              const speciesId =
                active === null ? null : (active.plannedPath[active.stageIndex] ?? null);
              return {
                apiKeyId: row.apiKeyId,
                // Null for an egg and null for an unreadable save. The card
                // draws an egg for the first and says so for the second, which
                // is why `unreadable` is a field of its own rather than
                // something the panel infers from a missing species.
                speciesId,
                name: await nameOf(speciesId),
                rarity: active?.rarity ?? null,
                isShiny: active?.isShiny ?? false,
                tokensTotal: row.tokensTotal,
                wallet: wallet(row),
                lastCreditAt: row.lastCreditAt,
                unreadable: row.state === null,
              };
            }),
          );
          return { json: { keys } };
        },
      },
      {
        method: "GET",
        path: "/keys/:id",
        handler: async (request) => {
          const apiKeyId = request.params.id ?? "";
          settleAndRecord(apiKeyId);
          const row = readCompanion(storage, apiKeyId);
          if (row === null) return { status: 404, json: { error: "no companion for that key" } };

          // Best effort and deliberately not awaited: a prefetch is an
          // optimisation for the next hatch, and the panel should render now.
          if (row.state !== null) void prefetchOnce(apiKeyId, row.state).catch(() => {});

          const active = row.state?.active ?? null;
          const dex = readDex(storage, apiKeyId);
          return {
            json: {
              // Null rather than a fresh companion, so "cannot be read" and "has
              // not started" stay distinguishable in the UI.
              state: row.state,
              tokensTotal: row.tokensTotal,
              wallet: wallet(row),
              /**
               * When this key last earned, for the panel's activity state.
               *
               * The instant rather than a derived label, because the elapsed
               * time is what the panel actually draws with and a label computed
               * here would be stale by the time it was rendered — a companion
               * that fell asleep between the poll and the paint.
               *
               * Null for a row written before the column existed, and that is a
               * fact the panel renders rather than one it guesses around.
               */
              lastCreditAt: row.lastCreditAt,
              /**
               * What this companion is called right now — the stage it is
               * standing at, not the species it hatched as.
               *
               * Resolved here rather than in the browser because the name lives
               * in the plugin's own cache directory, which the panel has no
               * route to and no business having one to. Null is an ordinary
               * answer: an egg has no species, and a cold cache has no name yet.
               */
              name: await nameOf(
                active === null ? null : (active.plannedPath[active.stageIndex] ?? null),
              ),
              // The name of what each entry graduated into, added alongside the
              // stored row rather than into it: the Dex table holds facts about
              // a graduation, and a species' name is a fact about PokéAPI.
              dex: await Promise.all(
                dex.map(async (entry) => ({ ...entry, name: await nameOf(entry.finalId) })),
              ),
              shop: shopCatalogue(),
              /**
               * What the current stage costs, so the panel can draw a meter that
               * means something.
               *
               * Computed here rather than in the browser because the thresholds
               * are the economy: shipping the balance table to the client would
               * put the rules in two places, and the one that drifts is the one
               * nobody is looking at.
               */
              nextThreshold:
                active === null
                  ? EGG_HATCH_THRESHOLD
                  : phaseThreshold(active.rarity, active.plannedPath.length, active.stageIndex),
              progress: active === null ? (row.state?.eggUsage ?? 0) : active.usedAtStage,
            },
          };
        },
      },
      {
        method: "GET",
        path: "/sprite/:species",
        handler: async (request) => {
          // The one route that answers with bytes. Ids are parsed as integers
          // here and validated again inside `spriteBytes`, so nothing a caller
          // types reaches a URL or a cache path.
          const raw = request.params.species ?? "";
          const speciesId = Number.parseInt(raw, 10);
          if (!Number.isInteger(speciesId)) return { status: 400, json: { error: "bad species" } };
          if (net === undefined || files === undefined) {
            return { status: 503, json: { error: "sprites need the net and files capabilities" } };
          }

          const shiny = request.query.shiny === "1";
          const bytes = await spriteBytes({ net, files }, speciesId, shiny);
          // A miss is ordinary — offline, or simply not fetched yet — so this is
          // a 404 the panel renders as a placeholder rather than an error state.
          if (bytes === null) return { status: 404, json: { error: "no sprite" } };
          return {
            bytes,
            contentType: "image/gif",
            // Sprites never change. This is the one thing in the plugin worth
            // caching hard, and it is why the panel stays responsive offline.
            cacheControl: "public, max-age=31536000, immutable",
          };
        },
      },
      {
        method: "POST",
        path: "/keys/:id/use",
        handler: (request) => {
          // The other half of a grant. Without this route a granted candy was a
          // counter that only ever went up: the shop's rare candy applied its XP
          // and charged the wallet, and nothing anywhere read `inventory`. A
          // whole spec section, a table and an event subscription produced
          // something unspendable.
          const apiKeyId = request.params.id ?? "";
          const item = parseHeldItem(request.body);
          if (item === null) return { status: 400, json: { error: "unknown item" } };

          const result = consume(
            storage,
            apiKeyId,
            item,
            (state) => useItem(state, item),
            ctx.now(),
          );
          if (!result.ok) return { status: 409, json: { error: result.reason } };
          settleAndRecord(apiKeyId);
          return { json: { ok: true } };
        },
      },
      {
        method: "POST",
        path: "/keys/:id/purchase",
        handler: (request) => {
          const apiKeyId = request.params.id ?? "";
          const entry = parseShopEntry(request.body);
          if (entry === null) return { status: 400, json: { error: "unknown shop entry" } };

          const result = purchase(
            storage,
            apiKeyId,
            entry,
            (state) => applyPurchase(state, entry),
            ctx.now(),
          );
          if (!result.ok) return { status: 409, json: { error: result.reason } };
          return { json: { ok: true, wallet: wallet(result.row) } };
        },
      },
    ];

    return { routes };
  },
});

/** A deterministic 32-bit seed from a string, so a retried roll is the same roll. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shopCatalogue(): Array<{ entry: ShopEntry; price: number }> {
  return [
    ...ITEM_KINDS.map((item) => ({
      entry: { kind: "item" as const, item },
      price: ITEM_PRICES[item],
    })),
    { entry: { kind: "egg" as const, tier: null }, price: freshEggPrice(null) },
    {
      entry: { kind: "egg" as const, tier: "uncommon" as const },
      price: freshEggPrice("uncommon"),
    },
    { entry: { kind: "egg" as const, tier: "rare" as const }, price: freshEggPrice("rare") },
  ];
}

function parseShopEntry(body: unknown): ShopEntry | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.kind === "item") {
    const item = record.item;
    return ITEM_KINDS.includes(item as ItemKind) ? { kind: "item", item: item as ItemKind } : null;
  }
  if (record.kind === "egg") {
    const tier = record.tier;
    if (tier === null || tier === undefined) return { kind: "egg", tier: null };
    // `legendary` is refused here as well as by the price function: an unknown
    // tier must not become "no guarantee" and quietly sell a cheap egg.
    if (tier === "uncommon" || tier === "rare") return { kind: "egg", tier };
    return null;
  }
  return null;
}

/**
 * What owning the thing does.
 *
 * A fresh egg discards the current Pokémon outright — it is a reroll, and the
 * discarded one is not a graduation, so it never reaches the Dex. That is what
 * keeps rerolling from being a way to farm the collection.
 */
function applyPurchase(state: CompanionState, entry: ShopEntry): CompanionState {
  if (entry.kind === "egg") {
    return { ...state, active: null, eggUsage: 0, eggTier: entry.tier, pendingHatch: null };
  }
  // A bought candy is stocked rather than spent on the spot, so buying and
  // being granted one put the same thing in the same place — and `use` is the
  // single site that applies the effect.
  return {
    ...state,
    inventory: { ...state.inventory, [entry.item]: (state.inventory[entry.item] ?? 0) + 1 },
  };
}

/** Items a player holds and spends, as opposed to the passive charm. */
export type HeldItem = "rareCandy" | "mint";

function parseHeldItem(body: unknown): HeldItem | null {
  if (typeof body !== "object" || body === null) return null;
  const item = (body as Record<string, unknown>).item;
  return item === "rareCandy" || item === "mint" ? item : null;
}

/**
 * What spending a held item does.
 *
 * A candy is injected as growth through the same field earned tokens land in,
 * so it carries a stage and evolves exactly as work would — no separate path,
 * no separate rules.
 *
 * A mint rerolls the nature, which is cosmetic and affects nothing else. It was
 * previously a no-op that incremented a counter nobody read, and a test asserted
 * that counter, pinning the no-op as correct.
 */
function useItem(state: CompanionState, item: HeldItem): CompanionState {
  if (item === "mint") {
    if (state.active === null) return state;
    const index = NATURES.indexOf(state.active.nature);
    // Deterministic rather than random: `advance` and everything around it is
    // pure, and a reroll that needed entropy would be the one call in the plugin
    // that could not be reproduced. Cycling is a reroll a player can repeat.
    const nature = NATURES[(index + 1) % NATURES.length] as (typeof NATURES)[number];
    return { ...state, active: { ...state.active, nature } };
  }
  return state.active === null
    ? { ...state, eggUsage: state.eggUsage + RARE_CANDY_XP }
    : {
        ...state,
        active: { ...state.active, usedAtStage: state.active.usedAtStage + RARE_CANDY_XP },
      };
}
