import { expect, test } from "bun:test";
import { ITEM_KINDS, ODDS, RARE_CANDY_XP, SOOTHE_BONUS } from "../src/balance.ts";
import { HELD_ITEMS } from "../src/server.ts";
import { CONSUMABLE_ITEMS, itemCard } from "../ui/catalog.ts";
import { formatTokens } from "../ui/format.ts";

/**
 * The one place the panel's copy can be checked against the server's constants.
 *
 * The panel cannot import from `src/`: the two halves are deployed as one npm
 * package and loaded by two different runtimes, so a shared module would be a
 * build edge between two bundles. That boundary is deliberate and stays. What it
 * costs is that every number written into a blurb — 100M of growth, 25% faster,
 * 1 in 48 — is prose duplicating a constant, with nothing to notice when the
 * constant moves.
 *
 * A *test* is under no such restriction. It runs in one process and can import
 * both halves, which makes this file the seam: the drift is not prevented, it is
 * detected, and it is detected at the point where somebody changed the balance
 * rather than months later when an operator reads a sentence that is no longer
 * true.
 *
 * This is the same idea as `test/helpers/storage.ts` mirroring the host's
 * storage rules — a mirror that a test holds honest.
 *
 * It imports no renderer. `ui/catalog.ts` is data and `ui/format.ts` is
 * pure, so both belong in the server run rather than behind happy-dom.
 */

test("every item the shop can sell has a description", () => {
  // Copy fails open, so a missing blurb is a working shop with a silent gap
  // rather than a crash — which is exactly the kind of thing that ships. This
  // is what makes adding a priced item without describing it a failing test
  // instead of an empty paragraph nobody notices.
  for (const item of ITEM_KINDS) {
    expect(itemCard(item).blurb).not.toBe("");
    expect(itemCard(item).emoji).not.toBe("❔");
  }
});

test("the blurbs quote the numbers the server actually uses", () => {
  // Each of these is a sentence duplicating a constant. Asserting the rendered
  // form rather than the raw number is the point: the blurb says "100M" and the
  // constant is 100_000_000, and `formatTokens` is the same function that puts
  // the price on the card beside it.
  expect(itemCard("rareCandy").blurb).toContain(formatTokens(RARE_CANDY_XP));
  expect(itemCard("sootheBell").blurb).toContain(`${SOOTHE_BONUS * 100}%`);
  expect(itemCard("shinyCharm").blurb).toContain(`1 in ${ODDS.shiny}`);
  expect(itemCard("shinyCharm").blurb).toContain(`1 in ${ODDS.shinyWithCharm}`);
});

test("the panel offers to spend exactly what the server will accept", () => {
  // `CONSUMABLE_ITEMS` is a mirror of `HELD_ITEMS`, and a mirror drifts. The
  // failure is mild in one direction and not the other: an item missing from
  // the panel's list can never be spent from the bag, which looks like a bug in
  // the bag; one listed that the server rejects is a button that always 400s.
  // Neither loses anything, and both are avoidable here.
  expect([...CONSUMABLE_ITEMS].sort()).toEqual([...HELD_ITEMS].sort());
});

test("an item nobody has described still gets a card", () => {
  // The fail-open branch, pinned. An id the server sells that the catalogue has
  // never heard of keeps a row rather than vanishing from the shop.
  const unknown = itemCard("quickClaw");
  expect(unknown.blurb).toBe("");
  expect(unknown.emoji).toBe("❔");
  // Spendable, deliberately: an unknown item treated as passive could never be
  // spent from the panel at all, while one treated as spendable offers a button
  // the server refuses with a message the panel already shows.
  expect(unknown.consumable).toBe(true);
});
