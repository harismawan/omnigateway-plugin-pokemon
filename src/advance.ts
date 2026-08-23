import { EGG_HATCH_THRESHOLD, phaseThreshold, type Rarity, SOOTHE_BONUS } from "./balance.ts";
import type { Nature } from "./roll.ts";
import type { CompanionState, MonState } from "./state.ts";

/**
 * Something worth telling the player about, produced by `advance` rather than
 * inferred by comparing states.
 *
 * A caller needs these to write a Dex row and to notify; deriving them by
 * diffing before and after would mean re-implementing the rules that produced
 * them, in a second place, from less information.
 */
export type CompanionEvent =
  | { kind: "hatched"; speciesId: number; isShiny: boolean; ditto: boolean }
  | { kind: "evolved"; from: number; to: number }
  /**
   * A disguise dropped. Carries what it was pretending to be, because after
   * this the state no longer says — `plannedPath` is Ditto's from here on, and
   * the notification worth sending names the species that vanished.
   */
  | { kind: "revealed"; disguisedAs: number; speciesId: number }
  | {
      kind: "graduated";
      baseId: number;
      finalId: number;
      /**
       * The whole line, base first.
       *
       * Carried on the event because the Dex stores it and `advance` is the only
       * thing that knows it — reconstructing `[baseId, finalId]` at the call
       * site lost every middle form and wrote `[50, 50]` for a one-form line.
       */
      chainOrder: readonly number[];
      /**
       * When each stage in `chainOrder` was entered, and the only way out.
       *
       * Graduating discards the companion, so the state that accumulated these
       * is gone by the time the caller sees the result — carried here for the
       * same reason `chainOrder` is.
       */
      stageTimes: readonly number[];
      rarity: Rarity;
      isShiny: boolean;
      nature: Nature;
    };

export type AdvanceResult = {
  state: CompanionState;
  events: readonly CompanionEvent[];
};

/**
 * A stage that cannot be left however many tokens arrive, so a corrupt or
 * hostile path cannot spin here.
 */
const MAX_TRANSITIONS_PER_ADVANCE = 64;

/**
 * Applies everything `tokensTotal` has earned since this state last looked.
 *
 * **Idempotent by construction.** It is called on every read as well as on every
 * credit, so calling it twice with the same total must be a no-op — and it is,
 * because it works from `tokensTotal - state.consumedTotal` rather than from the
 * number it was handed. A version that took a delta would double-credit the
 * moment anything retried, and the retry is the normal case here: the console
 * polls.
 *
 * Pure. No clock, no randomness, no I/O. The species a hatch produces was rolled
 * earlier and written to `pendingHatch`, which is what lets this run offline and
 * what makes every transition below reproducible in a test.
 *
 * `now` is a parameter for that reason and not an exception to it — the rule
 * this plugin follows is that the clock is passed, never read. It is used for
 * one thing: stamping the instant a stage was entered, which is a fact no
 * amount of arithmetic over tokens can recover later. Every transition below
 * still depends only on the stored total, so passing a different `now` changes
 * the timestamps and nothing else.
 */
export function advance(state: CompanionState, tokensTotal: number, now: number): AdvanceResult {
  const gained = Math.max(0, Math.trunc(tokensTotal) - state.consumedTotal);

  const events: CompanionEvent[] = [];
  let next: CompanionState = { ...state, consumedTotal: Math.trunc(tokensTotal) };

  // Credit first, then look for transitions the new total makes possible. The
  // two are separate on purpose: an earlier version gated the whole function on
  // `gained > 0`, which meant an injected effect — a rare candy — sat in
  // `usedAtStage` past its threshold and did not evolve until the next real
  // request happened to arrive. On a revoked key that request never comes.
  if (gained > 0) {
    /*
      A soothe bell adds to what reaches the companion, and nothing else.

      `consumedTotal` above still absorbs the raw figure, which is what keeps
      this idempotent: a second settle at the same total computes a delta of
      zero. And `tokensTotal` is the caller's, untouched here, which is the
      property that matters most — the wallet is derived from it, so a bell that
      grew the ledger would print the tokens to buy the next bell.

      The bonus is computed against the running total rather than this delta,
      and that is not a refinement. Rounding a slice of each delta made growth
      depend on how the traffic arrived: `gained × 1.25` lands on an exact .5
      whenever `gained ≡ 2 (mod 4)` and rounds up, so ten credits of two tokens
      granted 30 where one credit of twenty granted 25. Upward bias, averaging
      +0.125 per settle, which quietly falsified the "cannot repay its own cost"
      argument the item is priced on.

      Eggs are excluded because the bell is applied to a companion and an egg is
      not one.
     */
    const active = next.active;
    if (active === null) {
      next = { ...next, eggUsage: next.eggUsage + gained };
    } else if (!active.soothe) {
      next = { ...next, active: { ...active, usedAtStage: active.usedAtStage + gained } };
    } else {
      // Against the running total, not this delta. The bonus owed is always
      // `floor(soothedRaw × BONUS)`, so what this credit adds is the difference
      // between that and what has already been granted — which makes the total
      // identical however the tokens arrived.
      const raw = active.soothedRaw + gained;
      const owed = Math.floor(raw * SOOTHE_BONUS) - Math.floor(active.soothedRaw * SOOTHE_BONUS);
      next = {
        ...next,
        active: { ...active, soothedRaw: raw, usedAtStage: active.usedAtStage + gained + owed },
      };
    }
  }

  for (let step = 0; step < MAX_TRANSITIONS_PER_ADVANCE; step++) {
    if (next.active === null) {
      if (next.eggUsage < EGG_HATCH_THRESHOLD) break;
      // The egg has met its threshold. Whether it can open is a different
      // question: the species is rolled ahead of time, and without that roll
      // there is nothing to become. The progress waits rather than draining, so
      // the moment a roll lands the hatch happens with its incubation intact.
      if (next.pendingHatch === null) break;

      const hatch = next.pendingHatch;
      const active: MonState = {
        baseId: hatch.path[0] ?? hatch.speciesId,
        plannedPath: hatch.path,
        stageIndex: 0,
        // Stage 0 begins here. Stamped at the transition rather than when the
        // egg met its threshold, because those are different instants whenever
        // a roll had not landed yet and the egg sat waiting for one.
        stageTimes: [now],
        // Everything past the threshold carries into the hatchling rather than
        // being lost, so a burst that overshoots is not punished.
        usedAtStage: next.eggUsage - EGG_HATCH_THRESHOLD,
        rarity: hatch.rarity,
        isShiny: hatch.isShiny,
        nature: hatch.nature,
        dittoDisguise: hatch.ditto ? hatch.speciesId : null,
        dittoRevealed: false,
        // A hatchling carries nothing. Items are applied to a companion, and
        // the one this replaced took its own with it.
        everstone: false,
        soothe: false,
        soothedRaw: 0,
      };
      events.push({
        kind: "hatched",
        speciesId: hatch.speciesId,
        isShiny: active.isShiny,
        ditto: active.dittoDisguise !== null,
      });
      next = { ...next, active, eggUsage: 0, eggTier: null, pendingHatch: null };
      continue;
    }

    const mon = next.active;
    /*
      An everstone stops every transition, not only evolution.

      Blocking evolution alone would still let a one-form line — or a companion
      standing at its last stage — graduate away, and that is precisely the
      individual somebody pins a stone to keep. It blocks the Ditto reveal for
      the same reason: a reveal hands back a different Pokémon, which is not
      "keep this one as it is".

      Checked before the threshold rather than after, because a pinned companion
      is not waiting for anything — the growth simply accumulates in
      `usedAtStage` and is spent the moment the stone comes off.
     */
    if (mon.everstone) break;

    const needed = phaseThreshold(mon.rarity, mon.plannedPath.length, mon.stageIndex);
    if (mon.usedAtStage < needed) break;

    const excess = mon.usedAtStage - needed;

    /*
      A Ditto cannot evolve, so the threshold that would have evolved it is the
      moment it stops pretending. Checked before the evolution branch because it
      *replaces* that transition — running it after would let a disguise reach
      its second form first, and a Ditto that got to evolve once is a different
      creature from the one the roll promised.

      `dittoRevealed` is what keeps this from firing at every later threshold.
    */
    if (mon.dittoDisguise !== null && !mon.dittoRevealed) {
      // No resolved line, no reveal. The progress waits rather than draining, so
      // the reveal happens with its growth intact once the line arrives — the
      // same rule the egg follows when it has met its threshold and has nothing
      // to become. Inventing Ditto's rarity here would pick a graduation total
      // out of the air and the companion would carry it for the rest of its
      // life.
      if (next.pendingReveal === null) break;

      const reveal = next.pendingReveal;
      events.push({
        kind: "revealed",
        disguisedAs: mon.plannedPath[mon.stageIndex] ?? mon.baseId,
        speciesId: reveal.path[0] as number,
      });
      next = {
        ...next,
        active: {
          ...mon,
          baseId: reveal.path[0] as number,
          plannedPath: reveal.path,
          stageIndex: 0,
          // Started over, not carried across. `plannedPath` is a different line
          // from here and `stageIndex` resets with it, so the disguise's
          // instants would date the revealed base form to a stage it never
          // occupied. The growth crosses over; the history does not.
          stageTimes: [now],
          // The disguise's overflow is this individual's growth and follows it
          // across, exactly as it does through an evolution.
          usedAtStage: excess,
          rarity: reveal.rarity,
          dittoRevealed: true,
        },
        pendingReveal: null,
      };
      continue;
    }

    if (mon.stageIndex < mon.plannedPath.length - 1) {
      events.push({
        kind: "evolved",
        from: mon.plannedPath[mon.stageIndex] as number,
        to: mon.plannedPath[mon.stageIndex + 1] as number,
      });
      next = {
        ...next,
        active: {
          ...mon,
          stageIndex: mon.stageIndex + 1,
          usedAtStage: excess,
          // Appended, so the array stays parallel to `plannedPath`. Several
          // evolutions in one `advance` all carry this call's `now` — see the
          // note on `stageTimes` about observed rather than true instants.
          stageTimes: [...mon.stageTimes, now],
        },
      };
      continue;
    }

    events.push({
      kind: "graduated",
      baseId: mon.baseId,
      finalId: mon.plannedPath[mon.plannedPath.length - 1] as number,
      chainOrder: mon.plannedPath,
      // The last stage is entered and left in the same step — a graduation is
      // the transition *out* of the final form — so its instant is this call's
      // `now` and was never appended to the state that is about to be
      // discarded. Padded here rather than in the caller, so the two arrays the
      // Dex stores are the same length by construction.
      stageTimes: [...mon.stageTimes, now].slice(0, mon.plannedPath.length),
      rarity: mon.rarity,
      isShiny: mon.isShiny,
      nature: mon.nature,
    });
    // Graduating returns to an egg carrying the overflow. The Dex row is the
    // caller's to write from the event: this function owns no storage.
    next = { ...next, active: null, eggUsage: excess, eggTier: null, pendingHatch: null };
  }

  return { state: next, events };
}
