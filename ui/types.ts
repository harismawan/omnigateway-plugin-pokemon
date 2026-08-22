/**
 * What the plugin's two read routes send, as the panel consumes it.
 *
 * Hand-written rather than imported from `src/`. The server half runs in the
 * gateway and the panel runs in a browser, and a shared type would be a build
 * edge between two bundles that are deployed as one npm package but loaded by
 * two different runtimes. What keeps these honest is the integration suite,
 * which asserts the wire shape from the server's side.
 */

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

export type ShopEntry = { kind: "item"; item: string } | { kind: "egg"; tier: Rarity | null };

/** One individual that passed through a species, as the record's history lists it. */
export type DexCatch = {
  /** The Dex row's id, so a catch list has stable keys. */
  id: string;
  /**
   * The evolution line this individual walked.
   *
   * On the catch rather than on the species, because Eevee's chain branches: a
   * Vaporeon catch walked `[133, 134]` and a Jolteon catch `[133, 135]`, and a
   * single line on the Eevee record would have to pick one and print
   * "Eevee → Vaporeon" over a Jolteon the player also owns.
   */
  chainOrder: number[];
  isShiny: boolean;
  /** Null for a graduation recorded before natures were stored. */
  nature: string | null;
  /** When the whole line graduated — the same instant for every species on it. */
  caughtAt: number;
  /**
   * When this individual reached *this* species, or null for never recorded.
   *
   * Null for a graduation from before the plugin stored stage instants, and for
   * a stage that graduation had already passed when it started. The record
   * falls back to `caughtAt` and says that is what it did.
   */
  enteredAt: number | null;
};

/**
 * One species this key has owned, however many individuals it took.
 *
 * A species and not a graduation, which is the difference between a Pokédex and
 * a log: graduating a Venusaur puts Bulbasaur, Ivysaur and Venusaur here,
 * because a row is written only once an individual has walked its whole line.
 * The server derives these from the stored graduations on read — see
 * `src/collection.ts`.
 */
export type DexSpecies = {
  speciesId: number;
  rarity: Rarity;
  /** True when **any** individual of this species was shiny. */
  isShiny: boolean;
  firstCaughtAt: number;
  /**
   * Whether `firstCaughtAt` is when this species was reached, or a stand-in.
   *
   * False when no catch recorded an instant for this stage, in which case the
   * date is the earliest *graduation* instead. For a pre-evolution the two can
   * be months apart, so the panel names which one it is showing rather than
   * presenting a graduation as a first sighting.
   */
  firstCaughtExact: boolean;
  /** Newest first by stage instant. */
  catches: DexCatch[];
  /** Resolved from the plugin's own species cache, so null on a cold one. */
  name: string | null;
};

export type CompanionView = {
  state: {
    active: {
      plannedPath: number[];
      stageIndex: number;
      usedAtStage: number;
      rarity: Rarity;
      isShiny: boolean;
      nature: string;
      dittoDisguise: number | null;
      /** True once the disguise has been dropped, which is when the hint stops. */
      dittoRevealed: boolean;
      /** Pinned: this companion will not evolve, reveal, or graduate. */
      everstone: boolean;
      /** Growing faster, for as long as this companion lasts. */
      soothe: boolean;
    } | null;
    eggUsage: number;
    eggTier: Rarity | null;
    inventory: Record<string, number>;
  } | null;
  tokensTotal: number;
  wallet: number;
  /**
   * When this key last earned, or null for a save that predates the column.
   *
   * Distinct from anything derived from `updated_at`: a purchase moves that and
   * not this, which is the whole reason the column exists.
   */
  lastCreditAt: number | null;
  /** What the stage the companion is standing at is called, or null. */
  name: string | null;
  dex: DexSpecies[];
  shop: Array<{ entry: ShopEntry; price: number }>;
  /** What the current stage or incubation costs. */
  nextThreshold: number;
  /** How far into it this companion is. */
  progress: number;
};

/**
 * One key's card on the roster.
 *
 * Flatter than `CompanionView` on purpose: a card draws a sprite, a name and
 * two numbers, and shipping every card's whole save to draw that would make
 * opening the panel proportional to how many keys an install has.
 */
export type RosterKey = {
  apiKeyId: string;
  /** Null for an egg, and null for a save that could not be read. */
  speciesId: number | null;
  name: string | null;
  rarity: Rarity | null;
  isShiny: boolean;
  tokensTotal: number;
  wallet: number;
  lastCreditAt: number | null;
  /** The reason a species is missing, when it is missing for the bad reason. */
  unreadable: boolean;
};

export type Roster = { keys: RosterKey[] };
