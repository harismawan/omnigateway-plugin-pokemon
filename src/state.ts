import {
  type GuaranteedTier,
  ITEM_KINDS,
  type ItemKind,
  RARITIES,
  type Rarity,
} from "./balance.ts";
import { NATURES, type Nature } from "./roll.ts";

/**
 * The Pokémon currently being raised.
 *
 * `plannedPath` is fixed at hatch from the species' evolution chain, so
 * `advance` never needs the network to know what comes next. That is what keeps
 * the state machine pure and what lets a companion keep growing while PokéAPI is
 * unreachable.
 */
export type MonState = {
  baseId: number;
  /** Species ids from first form to last, decided at hatch. */
  plannedPath: readonly number[];
  stageIndex: number;
  /**
   * When each stage was entered, parallel to `plannedPath` up to `stageIndex`.
   *
   * Stored because nothing downstream can reconstruct it. Growth is measured in
   * tokens and no arithmetic over tokens yields a date, and the one table that
   * holds instants — `request_logs` — is pruned by retention and is forbidden
   * as a source here for exactly that reason.
   *
   * **The instant is when the gateway *observed* the stage, not when it truly
   * began.** The plugin only learns about growth when a credit arrives, so one
   * large credit that carries a companion through three stages stamps all three
   * with its own instant. That is the honest granularity; interpolating across
   * the gap between credits would manufacture times the plugin does not have.
   *
   * Empty for a companion that hatched before this field existed — an absent
   * fact rather than a zero, and the Dex renders it as one.
   */
  stageTimes: readonly number[];
  /** Tokens accumulated into the current stage. */
  usedAtStage: number;
  rarity: Rarity;
  isShiny: boolean;
  nature: Nature;
  /** Set when this is a Ditto wearing another species; null for an ordinary hatch. */
  dittoDisguise: number | null;
  dittoRevealed: boolean;
  /**
   * An everstone is on this companion: it will not evolve, reveal, or graduate.
   *
   * A property of the individual rather than of the save, so it goes with the
   * companion — a fresh egg does not inherit the stone that was pinning the one
   * it replaced.
   */
  everstone: boolean;
  /**
   * A soothe bell is on this companion, adding `SOOTHE_BONUS` to its growth.
   *
   * Ends when the companion does. That is what bounds the item: it can never
   * return more than its fraction of one graduation total, which is what makes
   * it priceable at all — see `ITEM_PRICES.sootheBell`.
   */
  soothe: boolean;
  /**
   * Raw tokens this companion has absorbed while holding a soothe bell.
   *
   * Kept so the bell's bonus is `floor(soothedRaw × SOOTHE_BONUS)` computed
   * against the running total, rather than a rounded slice of each delta. The
   * per-delta form made growth depend on how the traffic arrived: ten credits of
   * two tokens rounded up ten times and out-granted one credit of twenty by
   * 20%. Growth has to be a function of tokens earned.
   */
  soothedRaw: number;
};

export type CompanionState = {
  /**
   * Every token ever credited that this state has already absorbed.
   *
   * The reason `advance` is idempotent. It is called on every read as well as on
   * every credit, so it must be safe to call twice with the same total — and it
   * is, because it works from the difference against this rather than from
   * whatever it was handed.
   */
  consumedTotal: number;
  /** Null while an egg is incubating. */
  active: MonState | null;
  /** Tokens into the current egg. Reset at every hatch. */
  eggUsage: number;
  /**
   * The rarity floor this egg was bought with.
   *
   * Persisted rather than held in memory, because the purchase happens before
   * the roll: buying a guaranteed egg cannot pick a species on the spot, since
   * that needs the candidate index. Writing the guarantee down is what makes the
   * purchase survive a restart and an offline stretch.
   */
  eggTier: GuaranteedTier | null;
  /**
   * The species this egg will hatch into, rolled in advance.
   *
   * Prefetched while the egg is still incubating so the hatch itself is a local
   * transition. Without it, hatching would need the network at the exact moment
   * it happens, and an offline gateway would hold an egg that has met its
   * threshold and cannot open.
   */
  pendingHatch: {
    speciesId: number;
    path: readonly number[];
    rarity: Rarity;
    /**
     * The rest of the roll, carried with it.
     *
     * Shininess and the Ditto disguise are decided when the roll happens, not
     * when the egg opens — so they are written down here alongside the species.
     * Deciding them at hatch would need randomness inside `advance`, and that
     * one dependency would make every transition in the state machine
     * irreproducible.
     */
    isShiny: boolean;
    nature: Nature;
    ditto: boolean;
  } | null;
  /**
   * What a disguised companion becomes when it drops the act, resolved ahead of
   * the moment it does.
   *
   * The same trick as `pendingHatch` and for the same reason. A reveal needs
   * Ditto's own line and rarity, which live behind PokéAPI, and `advance` has no
   * capabilities — so the answer is written down while the disguise is still
   * growing and the transition itself stays a local one.
   *
   * Null is an ordinary state, not an error: a companion that is not disguised
   * has nothing to resolve, and a disguised one on a cold cache holds at its
   * threshold until this arrives. The alternative is inventing Ditto's rarity,
   * which decides what the revealed companion costs to graduate.
   */
  pendingReveal: {
    path: readonly number[];
    rarity: Rarity;
  } | null;
  /**
   * Modifiers waiting to be spent on the next roll.
   *
   * They live on the save rather than on the egg because they are bought before
   * there is anything to apply them to — the same reason `eggTier` is persisted.
   * All three are cleared in the write that stores the roll they shaped, so one
   * purchase buys one hatch.
   *
   * None of them touch the seed, so a retried prefetch still produces the same
   * Pokémon; they change which candidates are on the table, not which way the
   * dice fall.
   */
  lure: boolean;
  incense: boolean;
  /** A final form the next roll must not produce, or null. */
  repel: number | null;
  inventory: Record<ItemKind, number>;
  /**
   * Whether the first-run seeding of limit-window grants has happened.
   *
   * Without it, installing the plugin against an account already at its ceiling
   * pays out retroactively for windows it never watched fill.
   */
};

/**
 * A bag with one entry per item kind, all empty.
 *
 * Built from `ITEM_KINDS` rather than written out, because a literal is a list
 * of every item that existed on the day it was typed. There were three such
 * literals in `src/` and two dozen more across the tests, and each one is a
 * place an added item is silently missing — `Record<ItemKind, number>` would
 * catch it in `src/`, but a test fixture that builds its own object and never
 * mentions the new key just carries a hole into whatever it is asserting.
 */
export function emptyInventory(): Record<ItemKind, number> {
  const inventory = {} as Record<ItemKind, number>;
  for (const kind of ITEM_KINDS) inventory[kind] = 0;
  return inventory;
}

export function freshState(): CompanionState {
  return {
    consumedTotal: 0,
    active: null,
    eggUsage: 0,
    eggTier: null,
    pendingHatch: null,
    pendingReveal: null,
    lure: false,
    incense: false,
    repel: null,
    inventory: emptyInventory(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asRarity(value: unknown): Rarity | null {
  return RARITIES.includes(value as Rarity) ? (value as Rarity) : null;
}

/**
 * Parses a stored companion, or returns null.
 *
 * **Fails closed, deliberately, and this is the opposite of how the Dex reads.**
 *
 * An unreadable field here is not recoverable by guessing. A rarity that does
 * not parse decides the graduation total, so defaulting it silently changes how
 * much work the Pokémon costs — a change nothing would report and nobody would
 * notice. The row reads back as null, which the UI renders as "this save cannot
 * be read" rather than as a fresh egg, so an operator sees a problem instead of
 * silently losing months of growth.
 *
 * That is the `api_keys.limits` precedent: refuse where a wrong guess is
 * invisible. The Dex takes the other precedent (`isRtkFilterId`) because a bad
 * entry there costs one row of history and hiding the other two hundred would
 * be worse.
 */
export function parseState(raw: string): CompanionState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const inventory = emptyInventory();
  const storedInventory = parsed.inventory;
  if (isRecord(storedInventory)) {
    for (const kind of ITEM_KINDS) {
      inventory[kind] = Math.max(0, asInt(storedInventory[kind], 0));
    }
  }

  let active: MonState | null = null;
  const storedActive = parsed.active;
  if (storedActive !== null && storedActive !== undefined) {
    if (!isRecord(storedActive)) return null;

    const rarity = asRarity(storedActive.rarity);
    // The field that decides the cost of everything ahead. Unreadable means
    // unreadable, not "assume common".
    if (rarity === null) return null;

    const path = Array.isArray(storedActive.plannedPath)
      ? storedActive.plannedPath.filter((id): id is number => typeof id === "number" && id > 0)
      : [];
    // An empty path cannot render a sprite or decide what comes next, and there
    // is nothing to fall back to.
    if (path.length === 0) return null;

    const nature = NATURES.includes(storedActive.nature as Nature)
      ? (storedActive.nature as Nature)
      : null;
    // Nature is cosmetic, so an unknown one is the one field here that degrades
    // rather than refuses — it costs an adjective, not a number.
    active = {
      baseId: asInt(storedActive.baseId, path[0] as number),
      plannedPath: path,
      // Clamped rather than refused: a stage index past the end is recoverable
      // by pinning it to the last form, and the alternative is discarding a save
      // over an off-by-one.
      stageIndex: Math.min(Math.max(0, asInt(storedActive.stageIndex, 0)), path.length - 1),
      // Degrades to empty, never refuses. A save written before this field
      // existed has none, and that is the ordinary case for every companion
      // alive at the moment it shipped — refusing those would destroy months of
      // growth over a decoration. The Dex draws an absent instant as its own
      // state rather than guessing one, so "we did not record this" survives
      // all the way to the panel instead of being papered over here.
      stageTimes: Array.isArray(storedActive.stageTimes)
        ? storedActive.stageTimes.filter((at): at is number => typeof at === "number" && at >= 0)
        : [],
      usedAtStage: Math.max(0, asInt(storedActive.usedAtStage, 0)),
      rarity,
      isShiny: storedActive.isShiny === true,
      nature: nature ?? "hardy",
      dittoDisguise:
        typeof storedActive.dittoDisguise === "number" ? storedActive.dittoDisguise : null,
      dittoRevealed: storedActive.dittoRevealed === true,
      everstone: storedActive.everstone === true,
      /**
       * Degrades to "no bell", and this is the one degradation here that costs
       * the player something they paid 3B for.
       *
       * It is still the right direction. The alternative is refusing the save,
       * which renders as "this companion could not be read" and is a far worse
       * outcome than a bonus quietly ending — and `=== true` only fails to be
       * true for a field that is absent or corrupt, at which point the honest
       * reading is that we do not know whether a bell was ever applied. It
       * cannot silently *grant* one, which is the direction that would matter.
       */
      soothe: storedActive.soothe === true,
      // Degrades to zero, which under-grants rather than over-grants: the bell
      // starts counting again from here. The opposite default would hand back
      // bonus already paid out.
      soothedRaw: Math.max(0, asInt(storedActive.soothedRaw, 0)),
    };
  }

  const storedPending = parsed.pendingHatch;
  let pendingHatch: CompanionState["pendingHatch"] = null;
  if (isRecord(storedPending)) {
    const rarity = asRarity(storedPending.rarity);
    const path = Array.isArray(storedPending.path)
      ? storedPending.path.filter((id): id is number => typeof id === "number" && id > 0)
      : [];
    // A prefetch is an optimisation. An unreadable one is dropped and re-rolled
    // rather than refusing the save — nothing is lost but a network round trip.
    if (rarity !== null && path.length > 0) {
      const nature = NATURES.includes(storedPending.nature as Nature)
        ? (storedPending.nature as Nature)
        : "hardy";
      pendingHatch = {
        speciesId: asInt(storedPending.speciesId, path[0] as number),
        path,
        rarity,
        isShiny: storedPending.isShiny === true,
        nature,
        ditto: storedPending.ditto === true,
      };
    }
  }

  const storedReveal = parsed.pendingReveal;
  let pendingReveal: CompanionState["pendingReveal"] = null;
  if (isRecord(storedReveal)) {
    const rarity = asRarity(storedReveal.rarity);
    const path = Array.isArray(storedReveal.path)
      ? storedReveal.path.filter((id): id is number => typeof id === "number" && id > 0)
      : [];
    // Dropped and re-resolved rather than refusing the save, exactly like
    // `pendingHatch`: it is a prefetch, and losing one costs a round trip.
    if (rarity !== null && path.length > 0) pendingReveal = { path, rarity };
  }

  /*
    Fails closed, on the same side of the line as `rarity` and `plannedPath`.

    A default of zero does not mean "nothing spent yet" — `advance` computes
    `gained` as `tokensTotal - consumedTotal`, so on a key with a billion tokens
    of history a zero re-injects the whole lifetime as growth in one settle:
    graduation after graduation up to the transition cap, then more on the next
    settle, each writing a Dex row for work that was already paid for. Growth
    and collection granted twice for one lifetime of tokens, silently.

    This field decides how much work has already been accounted for, which makes
    it exactly the kind of invisible wrong guess this function refuses to make
    elsewhere. Zero remains perfectly valid when it is *stored* — every companion
    starts there — it is an absent or unreadable value that is refused.
  */
  const storedConsumed = parsed.consumedTotal;
  if (typeof storedConsumed !== "number" || !Number.isFinite(storedConsumed)) return null;

  const eggTier = asRarity(parsed.eggTier);

  return {
    // Clamped, not defaulted: a negative here would make `gained` larger than
    // the tokens actually credited.
    consumedTotal: Math.max(0, Math.trunc(storedConsumed)),
    active,
    eggUsage: Math.max(0, asInt(parsed.eggUsage, 0)),
    // A tier that does not parse becomes no guarantee, which is the safe
    // direction: it declines to invent a promise nobody paid for.
    eggTier: eggTier === null || eggTier === "legendary" ? null : eggTier,
    pendingHatch,
    pendingReveal,
    lure: parsed.lure === true,
    incense: parsed.incense === true,
    // Validated as a species id rather than trusted, because it reaches `roll`
    // as an exclusion and a non-integer would silently match nothing — a repel
    // that reads as spent and does not repel.
    repel:
      typeof parsed.repel === "number" && Number.isInteger(parsed.repel) && parsed.repel > 0
        ? parsed.repel
        : null,
    inventory,
  };
}

export function serialiseState(state: CompanionState): string {
  return JSON.stringify(state);
}

/** Whether the charm's permanent effect is in force. Held, never consumed. */
export function hasShinyCharm(state: CompanionState): boolean {
  return (state.inventory.shinyCharm ?? 0) > 0;
}
