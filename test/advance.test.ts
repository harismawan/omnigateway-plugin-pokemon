import { expect, test } from "bun:test";
import { advance } from "../src/advance.ts";
import {
  EGG_HATCH_THRESHOLD,
  graduationTotal,
  phaseThreshold,
  SOOTHE_BONUS,
} from "../src/balance.ts";
import { type CompanionState, freshState, parseState, serialiseState } from "../src/state.ts";

/** An egg with a species already rolled, which is the normal steady state. */
function readyEgg(over: Partial<CompanionState> = {}): CompanionState {
  return {
    ...freshState(),
    pendingHatch: {
      speciesId: 1,
      path: [1, 2, 3],
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      ditto: false,
    },
    ...over,
  };
}

test("advancing twice with the same total changes nothing the second time", () => {
  // The property everything else rests on. `advance` runs on every read as well
  // as every credit, and the console polls — so a version that credited what it
  // was handed rather than the difference would double-count on every refresh.
  const once = advance(readyEgg(), 4_000_000);
  const twice = advance(once.state, 4_000_000);

  expect(twice.state).toEqual(once.state);
  expect(twice.events).toEqual([]);
});

test("a total that went backwards credits nothing rather than un-growing", () => {
  // Should not happen — the counter is monotonic — but if it ever did, the
  // answer is to do nothing, not to reverse an evolution.
  const grown = advance(readyEgg(), 4_000_000);
  const backwards = advance(grown.state, 1_000);

  expect(backwards.state.eggUsage).toBe(grown.state.eggUsage);
  expect(backwards.events).toEqual([]);
});

test("an egg hatches at its threshold and carries the excess into the hatchling", () => {
  const result = advance(readyEgg(), EGG_HATCH_THRESHOLD + 250_000);

  expect(result.events).toEqual([{ kind: "hatched", speciesId: 1, isShiny: false, ditto: false }]);
  expect(result.state.active?.usedAtStage).toBe(250_000);
  expect(result.state.eggUsage).toBe(0);
});

test("an egg with no rolled species holds at its threshold instead of opening", () => {
  // The offline case. The species is rolled ahead of time, so with no roll there
  // is nothing to become — and the progress has to wait rather than drain, or an
  // outage would silently cost a player their incubation.
  const result = advance(freshState(), EGG_HATCH_THRESHOLD * 3);

  expect(result.events).toEqual([]);
  expect(result.state.active).toBeNull();
  expect(result.state.eggUsage).toBe(EGG_HATCH_THRESHOLD * 3);

  // And it opens the moment a roll lands, needing no further tokens.
  //
  // This assertion used to read the other way — that nothing moves without a new
  // credit — and that was the bug: a state already past its threshold sat there
  // until the next request happened to arrive, which on a quiet or revoked key
  // is never. Transitions are driven by the state now, not by the arrival of
  // tokens.
  const withRoll = advance({ ...result.state, pendingHatch: readyEgg().pendingHatch }, 0);
  expect(withRoll.events[0]?.kind).toBe("hatched");
  expect(withRoll.state.active?.usedAtStage).toBe(EGG_HATCH_THRESHOLD * 2);
});

test("a stage completes into an evolution, and the overflow carries", () => {
  const hatched = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const firstStage = phaseThreshold("common", 3, 0);

  const result = advance(hatched, hatched.consumedTotal + firstStage + 1_000);

  expect(result.events).toEqual([{ kind: "evolved", from: 1, to: 2 }]);
  expect(result.state.active?.stageIndex).toBe(1);
  expect(result.state.active?.usedAtStage).toBe(1_000);
});

test("a whole line graduates and returns to an egg", () => {
  // The full arc in one credit, which also exercises the carry between stages:
  // the graduation total is by definition enough for every stage of the line.
  const start = readyEgg();
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("common"));

  const kinds = result.events.map((e) => e.kind);
  expect(kinds).toEqual(["hatched", "evolved", "evolved", "graduated"]);

  const graduation = result.events.at(-1);
  expect(graduation).toMatchObject({ kind: "graduated", baseId: 1, finalId: 3, rarity: "common" });
  expect(result.state.active).toBeNull();
});

test("a graduation seeds the next egg with what overshot it", () => {
  // The third carry-over site and the only one nothing covered: the hatch
  // overflow kills six tests and the evolution overflow five, while `eggUsage:
  // excess` here could become `eggUsage: 0` with the suite still green. A single
  // large credit that carries a whole line and then some has to leave the
  // remainder incubating, exactly as the other two sites do — a burst that
  // finishes a Pokémon and starts the next one must not be charged twice for the
  // part that started the next one.
  const excess = 12_345_678;
  const result = advance(readyEgg(), EGG_HATCH_THRESHOLD + graduationTotal("common") + excess);

  expect(result.events.map((e) => e.kind)).toEqual(["hatched", "evolved", "evolved", "graduated"]);
  expect(result.state.active).toBeNull();
  // Not zero, and not the threshold either: a number that appears nowhere else
  // in the arithmetic, so only the carry-over can produce it.
  expect(result.state.eggUsage).toBe(excess);
  // The new egg is unrolled and unguaranteed, so nothing hatches out of the
  // graduate's leftovers by accident — it waits for its own roll.
  expect(result.state.pendingHatch).toBeNull();
  expect(result.state.eggTier).toBeNull();
});

test("a graduation carries the whole line and the nature, not just its ends", () => {
  // The Dex stores `chain_order`, and `advance` is the only thing that knows the
  // line. Rebuilding `[baseId, finalId]` at the call site lost every middle form
  // and wrote `[50, 50]` for a one-form line — with the column, the reader and
  // the spec all expecting a chain.
  // A nature that is NOT the parser's fallback, deliberately. An earlier version
  // of this used "hardy" — which is also the default — so replacing the field
  // with a hard-coded default was invisible and the mutation survived.
  const start = readyEgg({
    pendingHatch: {
      speciesId: 1,
      path: [1, 2, 3],
      rarity: "common",
      isShiny: false,
      nature: "sassy",
      ditto: false,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("common"));
  const graduation = result.events.at(-1);

  expect(graduation).toMatchObject({
    kind: "graduated",
    chainOrder: [1, 2, 3],
    nature: "sassy",
  });
});

test("a one-form line graduates without ever evolving", () => {
  const start = readyEgg({
    pendingHatch: {
      speciesId: 50,
      path: [50],
      rarity: "rare",
      isShiny: true,
      nature: "brave",
      ditto: false,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD + graduationTotal("rare"));

  expect(result.events.map((e) => e.kind)).toEqual(["hatched", "graduated"]);
  expect(result.events.at(-1)).toMatchObject({ finalId: 50, isShiny: true });
});

test("a hatch carries the shininess and disguise that were rolled with it", () => {
  // Decided at roll time, not at hatch time — otherwise `advance` would need
  // randomness and every transition here would stop being reproducible.
  const start = readyEgg({
    pendingHatch: {
      speciesId: 10,
      path: [10, 11],
      rarity: "common",
      isShiny: true,
      nature: "jolly",
      ditto: true,
    },
  });
  const result = advance(start, EGG_HATCH_THRESHOLD);

  expect(result.events[0]).toMatchObject({ kind: "hatched", isShiny: true, ditto: true });
  expect(result.state.active?.isShiny).toBe(true);
  expect(result.state.active?.dittoDisguise).toBe(10);
  expect(result.state.active?.nature).toBe("jolly");
});

test("consumed total always matches what was credited, whatever happened", () => {
  // The meter and the ledger cannot drift. A transition that blocks — a missing
  // roll — must still consume, or the gap grows every time it happens.
  for (const total of [1, EGG_HATCH_THRESHOLD - 1, EGG_HATCH_THRESHOLD * 2, 10_000_000_000]) {
    expect(advance(readyEgg(), total).state.consumedTotal).toBe(total);
    expect(advance(freshState(), total).state.consumedTotal).toBe(total);
  }
});

test("growth never runs backwards across a long random walk", () => {
  // Monotonicity stated as a property rather than as a single case. Nothing in
  // the arc — hatching, evolving, graduating back to an egg — may reduce the
  // total consumed.
  let state = readyEgg();
  let total = 0;
  let previous = 0;
  for (let i = 1; i <= 200; i++) {
    total += i * 137_000;
    // A graduation clears `pendingHatch`, so top it up the way the caller does.
    if (state.active === null && state.pendingHatch === null) {
      state = { ...state, pendingHatch: readyEgg().pendingHatch };
    }
    state = advance(state, total).state;
    expect(state.consumedTotal).toBeGreaterThanOrEqual(previous);
    previous = state.consumedTotal;
  }
});

// -------------------------------------------------------------- persistence

test("a companion round-trips through storage", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD + 400_000).state;
  expect(parseState(serialiseState(grown))).toEqual(grown);
});

test("an unreadable rarity refuses the whole save rather than guessing", () => {
  // Fails closed. A defaulted rarity silently changes the graduation total —
  // how much work the Pokémon costs — and nothing would report it.
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).rarity = "mythic-ultra";

  expect(parseState(JSON.stringify(corrupted))).toBeNull();
});

test("an empty evolution path refuses the save", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).plannedPath = [];

  expect(parseState(JSON.stringify(corrupted))).toBeNull();
});

test("an unknown nature degrades instead of refusing, because it costs an adjective", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).nature = "grumpy";

  const parsed = parseState(JSON.stringify(corrupted));
  expect(parsed).not.toBeNull();
  expect(parsed?.active?.nature).toBe("hardy");
});

test("a stage index past the end is clamped rather than discarding the save", () => {
  const grown = advance(readyEgg(), EGG_HATCH_THRESHOLD).state;
  const corrupted = JSON.parse(serialiseState(grown)) as Record<string, unknown>;
  (corrupted.active as Record<string, unknown>).stageIndex = 99;

  expect(parseState(JSON.stringify(corrupted))?.active?.stageIndex).toBe(2);
});

test("a legendary egg tier read back from storage becomes no guarantee", () => {
  // Nothing can sell one, so a stored one is corruption or a downgrade. Reading
  // it as "no guarantee" declines to invent a promise nobody paid for.
  const state = { ...freshState(), eggTier: "legendary" } as unknown as CompanionState;
  expect(parseState(JSON.stringify(state))?.eggTier).toBeNull();
});

test("garbage is null, not a fresh companion", () => {
  // The distinction the UI needs: "cannot be read" and "has not started" look
  // identical if both come back as a fresh egg, and only one of them is a
  // reason to stop and look.
  expect(parseState("not json")).toBeNull();
  expect(parseState("[1,2,3]")).toBeNull();
  expect(parseState("null")).toBeNull();
});

test("a corrupt path with more stages than the step cap cannot spin the loop", () => {
  // `MAX_TRANSITIONS_PER_ADVANCE` is the loop's only bound, and until this test
  // nothing reached it: a legitimate path is three stages, and the two ways out
  // of the loop after a graduation — no `pendingHatch`, no progress — both stop
  // it long before 64. So the cap looked like a guard against nothing.
  //
  // It is not. `plannedPath` comes off a JSON blob in the database, and nothing
  // between there and here bounds its length. A row with a thousand stages and
  // enough credited tokens to clear every one of them is the case this defends,
  // and the defence is worth having precisely because the input is stored rather
  // than computed.
  const stages = 500;
  const path = Array.from({ length: stages }, (_, index) => index + 1);
  const state: CompanionState = {
    ...freshState(),
    active: {
      baseId: 1,
      plannedPath: path,
      stageIndex: 0,
      usedAtStage: 0,
      rarity: "common",
      isShiny: false,
      nature: "hardy",
      dittoDisguise: null,
      dittoRevealed: false,
      everstone: false,
      soothe: false,
    },
  };

  // Far more than the whole path could ever need, so the loop is bounded by the
  // cap and by nothing else.
  const result = advance(state, graduationTotal("common") * stages);

  // The cap is a ceiling on transitions per call, not a refusal: what it must
  // not do is loop unboundedly, and what it must not do either is lose the
  // progress. Growth is preserved and the next call picks up where this stopped.
  expect(result.events.length).toBeLessThanOrEqual(64);
  expect(result.state.active?.stageIndex).toBeLessThanOrEqual(64);
  expect(result.state.active?.stageIndex).toBeGreaterThan(0);

  // The one place this file's headline property does not hold, and it is worth
  // being explicit rather than surprised by it later. `advance` is idempotent in
  // its *total*, so a second call with the same number normally changes nothing.
  // When the cap binds it does not: the call did as much as it was allowed and
  // the next one continues, walking a corrupt path 64 stages at a time until it
  // runs out. That is the intended trade — bounded work per call, no progress
  // lost, guaranteed termination — and it costs nothing in practice because a
  // real path is three stages and never reaches the cap at all.
  const again = advance(result.state, graduationTotal("common") * stages);
  expect(again.state.active?.stageIndex).toBeGreaterThan(result.state.active?.stageIndex ?? 0);
  expect(again.events.length).toBeLessThanOrEqual(64);
});

// --- the Ditto reveal ----------------------------------------------------------

/**
 * A Ditto wearing a common two-form line, one token short of the first
 * threshold it will never actually cross as its disguise.
 *
 * `common` and two forms because that is the only shape a disguise is rolled
 * onto — `roll` refuses the rest, so a fixture outside it would be testing a
 * state the game cannot produce.
 */
function disguisedMon(over: Partial<NonNullable<CompanionState["active"]>> = {}) {
  return {
    baseId: 10,
    plannedPath: [10, 11],
    stageIndex: 0,
    usedAtStage: 0,
    rarity: "common" as const,
    isShiny: false,
    nature: "jolly" as const,
    dittoDisguise: 10,
    dittoRevealed: false,
    everstone: false,
    soothe: false,
    ...over,
  };
}

function disguised(over: Partial<CompanionState> = {}): CompanionState {
  return {
    ...freshState(),
    consumedTotal: 0,
    active: disguisedMon(),
    pendingReveal: { path: [132], rarity: "rare" },
    ...over,
  };
}

/** What the disguise would have cost to leave, had it been going to evolve. */
const DISGUISE_THRESHOLD = phaseThreshold("common", 2, 0);

test("a disguised companion reveals instead of taking its first evolution", () => {
  const result = advance(disguised(), DISGUISE_THRESHOLD);

  expect(result.events).toEqual([{ kind: "revealed", disguisedAs: 10, speciesId: 132 }]);
  expect(result.state.active?.plannedPath).toEqual([132]);
  expect(result.state.active?.rarity).toBe("rare");
  expect(result.state.active?.dittoRevealed).toBe(true);
  // Nothing evolved: the reveal replaces that transition rather than following
  // it, so a Ditto never wears its disguise's second form.
  expect(result.events.some((event) => event.kind === "evolved")).toBe(false);
});

test("the reveal carries the overflow and keeps what was rolled at hatch", () => {
  const result = advance(
    disguised({ active: disguisedMon({ isShiny: true }) }),
    DISGUISE_THRESHOLD + 7_000,
  );

  expect(result.state.active?.usedAtStage).toBe(7_000);
  // Pinned alongside the overflow, because the overflow alone does not
  // distinguish a reveal from an ordinary evolution: leaving stage 0 of the
  // disguise would leave exactly the same 7,000 behind. Without these three the
  // test passes against a version that has no reveal at all.
  expect(result.state.active?.plannedPath).toEqual([132]);
  expect(result.state.active?.rarity).toBe("rare");
  expect(result.state.active?.dittoRevealed).toBe(true);
  // Shininess and nature are facts about this individual, not about the species
  // it was pretending to be.
  expect(result.state.active?.isShiny).toBe(true);
  expect(result.state.active?.nature).toBe("jolly");
});

test("a reveal that has not been resolved holds at the threshold", () => {
  // The offline case, and the same rule the egg follows: progress waits rather
  // than draining, so the moment the line arrives the reveal happens with its
  // growth intact. Inventing Ditto's rarity here would decide what the revealed
  // companion costs to graduate.
  const result = advance(disguised({ pendingReveal: null }), DISGUISE_THRESHOLD + 7_000);

  expect(result.events).toEqual([]);
  expect(result.state.active?.dittoRevealed).toBe(false);
  expect(result.state.active?.plannedPath).toEqual([10, 11]);
  // Held, not lost.
  expect(result.state.active?.usedAtStage).toBe(DISGUISE_THRESHOLD + 7_000);
  // And the ledger still moved, or the gap would grow on every blocked call.
  expect(result.state.consumedTotal).toBe(DISGUISE_THRESHOLD + 7_000);
});

test("an already-revealed Ditto evolves and graduates as an ordinary companion", () => {
  // `dittoRevealed` is what stops the reveal firing twice. Without it a Ditto
  // would re-reveal at every threshold and never graduate.
  const revealed = disguised({
    active: disguisedMon({
      baseId: 132,
      plannedPath: [132],
      rarity: "rare",
      dittoRevealed: true,
    }),
    pendingReveal: null,
  });

  const result = advance(revealed, graduationTotal("rare"));

  expect(result.events.map((event) => event.kind)).toEqual(["graduated"]);
  expect(result.events[0]).toMatchObject({ baseId: 132, finalId: 132 });
});

// --- the everstone and the soothe bell -----------------------------------------

/** A companion one token short of leaving its first stage, with nothing on it. */
function pinnable(over: Partial<NonNullable<CompanionState["active"]>> = {}): CompanionState {
  return {
    ...freshState(),
    active: {
      baseId: 10,
      plannedPath: [10, 11],
      stageIndex: 0,
      usedAtStage: 0,
      rarity: "common",
      isShiny: false,
      nature: "jolly",
      dittoDisguise: null,
      dittoRevealed: false,
      everstone: false,
      soothe: false,
      ...over,
    },
  };
}

const FIRST_STAGE = phaseThreshold("common", 2, 0);

test("an everstone holds a companion at its stage however much arrives", () => {
  const result = advance(pinnable({ everstone: true }), FIRST_STAGE * 4);

  expect(result.events).toEqual([]);
  expect(result.state.active?.stageIndex).toBe(0);
  // Held rather than discarded, which is what makes the stone reversible: the
  // growth is all still there to be released.
  expect(result.state.active?.usedAtStage).toBe(FIRST_STAGE * 4);
});

test("a pinned companion does not graduate either", () => {
  // Blocking evolution alone would leave a one-form line, or a companion at its
  // last stage, graduating away — which is exactly the individual somebody pins
  // a stone to keep.
  const single = pinnable({ plannedPath: [10], everstone: true });
  const result = advance(single, graduationTotal("common") * 2);

  expect(result.events).toEqual([]);
  expect(result.state.active).not.toBeNull();
});

test("a disguised companion with an everstone does not reveal", () => {
  // A reveal is a transition like any other, and "keep this one as it is" has to
  // mean this one — a stone that let the disguise drop would hand back a
  // different Pokémon than the one it was pinning.
  const disguisedAndPinned = disguised({
    active: disguisedMon({ everstone: true }),
  });
  const result = advance(disguisedAndPinned, DISGUISE_THRESHOLD * 3);

  expect(result.events).toEqual([]);
  expect(result.state.active?.dittoRevealed).toBe(false);
});

test("releasing an everstone lets the held growth spend itself", () => {
  // The reversibility, end to end: a companion that banked four stages' worth
  // while pinned catches up in one settle once the stone comes off.
  const banked = advance(pinnable({ everstone: true }), FIRST_STAGE * 4).state;
  const active = banked.active;
  expect(active).not.toBeNull();
  if (active === null) return;

  const released = advance({ ...banked, active: { ...active, everstone: false } }, FIRST_STAGE * 4);

  expect(released.events.map((event) => event.kind)).toContain("evolved");
});

test("a soothe bell grows the companion faster without earning it more", () => {
  const plain = advance(pinnable(), 1_000_000);
  const belled = advance(pinnable({ soothe: true }), 1_000_000);

  expect(plain.state.active?.usedAtStage).toBe(1_000_000);
  expect(belled.state.active?.usedAtStage).toBe(1_000_000 * (1 + SOOTHE_BONUS));
  // The ledger is untouched, which is what keeps the bell from printing the
  // tokens to buy the next one: growth is not earnings.
  expect(belled.state.consumedTotal).toBe(1_000_000);
  expect(belled.state.consumedTotal).toBe(plain.state.consumedTotal);
});

test("a soothe bell is still idempotent when the same total is settled twice", () => {
  const once = advance(pinnable({ soothe: true }), 1_000_000);
  const twice = advance(once.state, 1_000_000);

  expect(twice.state.active?.usedAtStage).toBe(once.state.active?.usedAtStage as number);
});

test("a soothe bell does nothing for an egg", () => {
  // The bell is applied to a companion, and an egg is not one. Nothing here
  // should scale incubation.
  const egg = { ...freshState(), eggUsage: 0 };
  expect(advance(egg, 1_000).state.eggUsage).toBe(1_000);
});
