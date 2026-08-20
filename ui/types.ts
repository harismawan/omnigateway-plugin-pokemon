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

export type DexEntry = {
  id: string;
  baseId: number;
  finalId: number;
  /** The full evolution line, as `readDex` returns it. */
  chainOrder: number[];
  rarity: Rarity;
  isShiny: boolean;
  /** Null for a graduation recorded before natures were stored. */
  nature: string | null;
  caughtAt: number;
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
  dex: DexEntry[];
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
