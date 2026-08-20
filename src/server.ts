// The `./define` subpath rather than the package root, deliberately. The root
// re-exports the manifest schema and with it zod, which a plugin never needs at
// runtime — importing it bundled half a megabyte of validator into every plugin
// that only wanted an identity function and some types.
import { definePlugin, type PluginContext, type PluginRoute } from "@omnigateway/plugin-api/define";
import type { CompanionEvent } from "./advance.ts";
import {
  DITTO_SPECIES_ID,
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
import {
  cachedSpeciesName,
  speciesDetail,
  speciesDetails,
  speciesIndex,
  spriteBytes,
} from "./pokeapi.ts";
import { NATURES, roll } from "./roll.ts";
import type { CompanionState } from "./state.ts";
import { hasShinyCharm } from "./state.ts";
import {
  consume,
  creditTokens,
  type ItemOutcome,
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

/**
 * How many unknown species one poll of the key route may go and look up.
 *
 * A Dex holds one row per graduation, so an install that has been running for
 * months can present a hundred names at once — and warming them unbounded would
 * be the burst `INDEX_FETCH_CONCURRENCY` exists to avoid, fired from a request
 * path rather than from a background prefetch. Eight per poll chews through a
 * large Dex over a few minutes of an open panel, which is the right pace for
 * something nobody is waiting on.
 */
const WARM_PER_POLL = 8;

/**
 * How long a species that could not be named is left alone, and the ceiling
 * that backoff climbs to.
 *
 * Both extremes here are wrong, and the first version of this shipped one of
 * them. Retrying on the next poll turns a species PokéAPI answers 404 for into
 * four requests a minute for as long as any panel is open — `fetchJson` cannot
 * tell a permanent 404 from an outage, so "it failed, the network must be down"
 * is an assumption that never expires. Never retrying loses a name to one bad
 * afternoon, which is the failure this whole warm-up exists to undo.
 *
 * Doubling from a minute to an hour costs a handful of attempts to establish
 * that something is permanently missing, and still recovers on its own from an
 * outage of any length.
 */
const WARM_BACKOFF_MS = 60_000;
const WARM_BACKOFF_MAX_MS = 60 * 60_000;

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
      // Both prefetches behind one latch, because they are two answers to the
      // same question — what does this companion become next — and exactly one
      // of them applies at a time: a hatch needs no active Pokémon, a reveal
      // needs one. A second latch would only let a poll start a reveal while a
      // hatch was still running for the same key.
      const started = prefetchHatch(apiKeyId, state)
        .then(() => prefetchReveal(apiKeyId, state))
        .finally(() => inFlight.delete(apiKeyId));
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
     * Species being fetched right now, so a poll that lands while an earlier
     * one is still in flight does not ask for the same documents again.
     *
     * Membership only — what to do about a species once its request *finishes*
     * is `cold`'s question, and conflating the two is what made the first
     * version retry a permanent 404 forever. This empties on settle by design.
     */
    const warming = new Set<number>();

    /**
     * Species that could not be named, and the instant it is worth asking again.
     *
     * The counterpart to `names` remembering only hits, and the two are not in
     * conflict: a hit is an immutable fact and is kept forever, a miss is a
     * guess about the world and is kept only as long as the guess is cheap to
     * hold. Without this the only dedup was `warming`, which empties the moment
     * a request settles — so a species that fails *deterministically* was asked
     * for again on the very next poll, and again, forever.
     *
     * `failures` is kept rather than just the deadline because the backoff
     * doubles, and a counter that reset on every attempt would never leave the
     * first rung.
     */
    const cold = new Map<number, { until: number; failures: number }>();

    /**
     * Fetches the species documents behind a set of missing names, in the
     * background, at a bounded rate, and never in a tight loop.
     *
     * This is the counterpart to `cachedSpeciesName` having no `net`, not a hole
     * in it. That function stays cache-only and stays cheap, because it is
     * called once per rendered sprite on every poll; this runs from the one
     * route that is showing a single companion. The roster deliberately does not
     * call it — see `GET /keys`.
     *
     * Needed because `prefetchHatch`, which is what fills the species cache,
     * returns early once a companion is active. A save that hatched before its
     * cache was lost — `data/` is excluded from database snapshots, so every
     * restore does exactly that — could never refill it, and showed `#11` for
     * the rest of the install's life.
     */
    const warmNames = (ids: readonly number[]): void => {
      if (net === undefined || files === undefined) return;
      const now = ctx.now();

      const batch: number[] = [];
      for (const id of ids) {
        if (batch.length >= WARM_PER_POLL) break;
        // Belt and braces at this call site, which only ever passes ids `nameOf`
        // has just missed on — and load-bearing for any other, which is the
        // point of a function that takes a list of ids rather than reading one.
        if (names.has(id) || warming.has(id)) continue;
        const chilled = cold.get(id);
        // Skipped without consuming a slot, so eight species PokéAPI has
        // forgotten cannot starve the ninth. `readDex` orders by `caught_at`,
        // so without this the same eight were retried on every poll and every
        // entry behind them was unreachable for the life of the process.
        if (chilled !== undefined && now < chilled.until) continue;
        batch.push(id);
        // Written before the next iteration, so a Dex holding one species twice
        // still produces one request.
        warming.add(id);
      }
      if (batch.length === 0) return;

      // One call rather than one per id, so a poll's warms share chain
      // resolution instead of fetching one evolution line eight times.
      void speciesDetails({ net, files }, batch)
        .then((details) => {
          batch.forEach((id, index) => {
            // "Did this produce a name", not "did this produce a document". A
            // cached species with no English entry parses perfectly and still
            // leaves the panel showing a number, and retrying it every poll
            // would burn a slot forever for a document already on disk.
            if (details[index]?.names.en !== undefined) {
              cold.delete(id);
              return;
            }
            const failures = (cold.get(id)?.failures ?? 0) + 1;
            const wait = Math.min(WARM_BACKOFF_MS * 2 ** (failures - 1), WARM_BACKOFF_MAX_MS);
            cold.set(id, { until: now + wait, failures });
          });
        })
        // `speciesDetails` answers `null` per id rather than throwing; this is
        // for the case it cannot cover, a capability that rejects outright.
        .catch(() => {})
        .finally(() => {
          for (const id of batch) warming.delete(id);
        });
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
     * Resolves what a disguised companion will turn out to be, before it does.
     *
     * The counterpart to `prefetchHatch` and the reason `advance` can stay pure
     * through a reveal: Ditto's line and rarity live behind PokéAPI, and the
     * transition itself must not need them. Resolved as soon as a disguise is
     * seen rather than at its threshold, so the answer is already on disk by the
     * time it is wanted — a reveal that had to wait for a fetch would stall a
     * companion at a threshold it had already paid for.
     *
     * Rarity is derived from the fetched detail rather than written down here,
     * for the same reason the hatch derives it: a hardcoded "Ditto is rare"
     * decides the graduation total the revealed companion carries for life, and
     * it would be a second copy of a fact PokéAPI already answers.
     */
    const prefetchReveal = async (apiKeyId: string, state: CompanionState): Promise<void> => {
      const mon = state.active;
      if (mon === null || mon.dittoDisguise === null || mon.dittoRevealed) return;
      if (state.pendingReveal !== null) return;
      if (net === undefined || files === undefined) return;

      const detail = await speciesDetail({ net, files }, DITTO_SPECIES_ID);
      if (detail === null) return;

      const current = readCompanion(storage, apiKeyId);
      // Re-read rather than trusting the state this started from: an await
      // happened, and a credit may have landed — or the reveal may already have
      // been resolved by a poll that overlapped this one.
      if (current?.state == null) return;
      const latest = current.state.active;
      if (latest === null || latest.dittoDisguise === null || latest.dittoRevealed) return;
      if (current.state.pendingReveal !== null) return;

      storage.run("UPDATE {{companion}} SET state = ?, updated_at = ? WHERE api_key_id = ?", [
        JSON.stringify({
          ...current.state,
          pendingReveal: {
            path: detail.chain,
            rarity: rarityFromCaptureRate(
              detail.captureRate,
              detail.isLegendary,
              detail.isMythical,
            ),
          },
        }),
        ctx.now(),
        apiKeyId,
      ]);
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
      /**
       * Whether a lure has anything left to find.
       *
       * A lure filters to uncollected finals, so on a complete Dex it would empty
       * the pool and the roll would answer null — indistinguishable from "the
       * candidate index has not arrived", and the egg would simply never hatch.
       *
       * Checked here rather than refused when the lure is used, because that is
       * the only place the candidate list exists: the Dex says what has been
       * collected but nothing on the save says what *could* be. An unusable lure
       * therefore stays armed rather than being spent — it is not refused, it
       * waits, and the next roll that has something new to offer uses it.
       */
      const lureUsable =
        state.lure && candidates.some((candidate) => !collected.has(candidate.finalId));

      const rolled = roll({
        candidates,
        // Seeded from facts rather than from a clock, so a retried prefetch
        // produces the same Pokémon instead of rerolling until it likes one.
        seed: hashSeed(`${apiKeyId}:${state.consumedTotal}`),
        guarantee: state.eggTier,
        hasShinyCharm: hasShinyCharm(state),
        collectedFinals: collected,
        // The three bought modifiers. None of them touch the seed — they change
        // which candidates are on the table, not which way the dice fall — so a
        // retried prefetch with the same modifiers still produces the same
        // Pokémon.
        onlyUncollected: lureUsable,
        preferLongLines: state.incense,
        excludeFinal: state.repel,
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
          // Spent in the same write that stores the roll they shaped, so one
          // purchase buys one hatch. Cleared here rather than at hatch time
          // because the roll is the moment they did their work — leaving them
          // set until the egg opens would let a second prefetch, after a fresh
          // egg replaced this one, reuse a modifier that has already been used.
          //
          // A lure that had nothing to find is the exception: it did no work, so
          // it is not spent.
          lure: state.lure && !lureUsable,
          incense: false,
          repel: null,
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

          const stageId = active === null ? null : (active.plannedPath[active.stageIndex] ?? null);
          const stageName = await nameOf(stageId);
          // The name of what each entry graduated into, added alongside the
          // stored row rather than into it: the Dex table holds facts about a
          // graduation, and a species' name is a fact about PokéAPI.
          const named = await Promise.all(
            dex.map(async (entry) => ({ ...entry, name: await nameOf(entry.finalId) })),
          );

          // Best effort and deliberately not awaited, like the prefetch above.
          // The companion first, so the heading fills in before the trophy case:
          // a poll's warming budget is small, and the name an operator is
          // looking at is worth more of it than one in a grid of sprites.
          warmNames([
            ...(stageId !== null && stageName === null ? [stageId] : []),
            ...named.filter((entry) => entry.name === null).map((entry) => entry.finalId),
          ]);

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
               * answer: an egg has no species, a cold cache has no name yet, and
               * `warmNames` above has just gone to fetch the second case.
               */
              name: stageName,
              dex: named,
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

/**
 * The shop, cheapest first.
 *
 * Sorted rather than written in a good order, because the order this was written
 * in *was* the declaration order — items by `ITEM_PRICES` key, then eggs — which
 * put the 3B charm above the 1B egg and read as a pile rather than a price list.
 * PokeTokenBar shipped exactly this bug and fixed it, and its note is worth
 * carrying: the fix must not be "group the eggs together", because that pushes
 * the 4B rare egg back above the charm and revives half of it. Price is the only
 * ordering the reader can verify from the row itself.
 *
 * Sorting here rather than in the panel keeps one answer to "what is on sale and
 * for how much" — a second ordering in the browser is a second thing to keep
 * true when an entry is added.
 */
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
  ].sort((a, b) => a.price - b.price);
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
/**
 * Items a player holds and spends, as opposed to the passive charm.
 *
 * A closed list rather than "every `ItemKind` that is not the charm", because
 * this is the enforcement boundary: an item added to `ITEM_PRICES` must be given
 * an effect deliberately, and a derived allowlist would admit it to the `use`
 * route the moment it was priced — with `useItem` falling through to whatever
 * its last branch happens to be.
 */
export const HELD_ITEMS = [
  "rareCandy",
  "mint",
  "everstone",
  "lure",
  "sootheBell",
  "incense",
  "repel",
] as const;

export type HeldItem = (typeof HELD_ITEMS)[number];

function parseHeldItem(body: unknown): HeldItem | null {
  if (typeof body !== "object" || body === null) return null;
  const item = (body as Record<string, unknown>).item;
  return HELD_ITEMS.includes(item as HeldItem) ? (item as HeldItem) : null;
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
function useItem(state: CompanionState, item: HeldItem): ItemOutcome {
  // The four that act on the companion itself. Each refuses without one rather
  // than returning the state unchanged — see `consume` for why the difference is
  // the item.
  if (item === "everstone" || item === "sootheBell" || item === "repel") {
    const active = state.active;
    if (active === null) return { refused: "no-companion" };

    if (item === "everstone") {
      // A toggle, and the only item here that gives something back. The stone is
      // spent to pin and the release is free: charging a second stone to undo
      // the first would make pinning a trap rather than a choice, and there is
      // nothing to return it to once it is on.
      return { applied: { ...state, active: { ...active, everstone: !active.everstone } } };
    }
    if (item === "sootheBell") {
      // Refused rather than silently re-applied. A bell already on this
      // companion cannot be improved by a second, and spending one to learn
      // that is the burn this whole ordering exists to prevent.
      if (active.soothe) return { refused: "nothing-new" };
      return { applied: { ...state, active: { ...active, soothe: true } } };
    }
    // The repel names the line it is refusing, resolved here rather than at roll
    // time: this is the companion the player is looking at when they decide they
    // do not want another, and by the time the next roll happens it is gone.
    const finalId = active.plannedPath[active.plannedPath.length - 1];
    if (finalId === undefined) return { refused: "no-companion" };
    return { applied: { ...state, repel: finalId } };
  }

  if (item === "lure" || item === "incense") {
    // Modifiers for a roll that has not happened. They need no companion — an
    // egg is exactly when they are worth buying — but re-arming one that is
    // already armed spends it for nothing.
    if (item === "lure") {
      if (state.lure) return { refused: "nothing-new" };
      return { applied: { ...state, lure: true } };
    }
    if (state.incense) return { refused: "nothing-new" };
    return { applied: { ...state, incense: true } };
  }

  if (item === "mint") {
    // Refused rather than returned unchanged. The two were indistinguishable to
    // `consume`, which is how a mint used on an egg was spent for nothing.
    if (state.active === null) return { refused: "no-companion" };
    const index = NATURES.indexOf(state.active.nature);
    // Deterministic rather than random: `advance` and everything around it is
    // pure, and a reroll that needed entropy would be the one call in the plugin
    // that could not be reproduced. Cycling is a reroll a player can repeat.
    const nature = NATURES[(index + 1) % NATURES.length] as (typeof NATURES)[number];
    return { applied: { ...state, active: { ...state.active, nature } } };
  }
  // A candy works on an egg as well as on a companion — it is growth, and an
  // egg grows. That is a deliberate divergence from the source app, which
  // refuses it; here the overflow past the hatch threshold carries into the
  // hatchling rather than being lost, so nothing is wasted.
  return {
    applied:
      state.active === null
        ? { ...state, eggUsage: state.eggUsage + RARE_CANDY_XP }
        : {
            ...state,
            active: { ...state.active, usedAtStage: state.active.usedAtStage + RARE_CANDY_XP },
          },
  };
}
