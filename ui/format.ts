/**
 * Everything the panel turns into words, in one place and with no JSX.
 *
 * Separated from the components because these are the decisions a test can pin
 * exactly: a boundary between two activity states, a species with no name, a
 * stored key like `rareCandy` becoming something a person reads. Inside a
 * component each of those is only reachable through a render.
 */

import type { Rarity, ShopEntry } from "./types.ts";

export function spriteUrl(pluginId: string, speciesId: number, shiny: boolean): string {
  return `/api/plugins/${pluginId}/sprite/${speciesId}${shiny ? "?shiny=1" : ""}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value.toLocaleString();
}

/**
 * What to call a species: its name, or its number.
 *
 * `#25` rather than `Species 25` for the heading, because it sits where a name
 * sits and the shorter form reads as a stand-in rather than as a sentence. The
 * fallback is not an error state — a fresh install has fetched nothing yet, and
 * the name appears on a later poll without anything else changing.
 */
export function speciesLabel(name: string | null, speciesId: number): string {
  return name ?? `#${speciesId}`;
}

/**
 * The accessible name of a sprite.
 *
 * Kept in the older `Species 25` phrasing when there is no name, because an alt
 * text is read aloud in a sentence and `#25` is not a word. Shininess is
 * appended rather than folded in: it is a property of this individual, not part
 * of what the species is called.
 */
export function spriteAlt(name: string | null, speciesId: number, shiny: boolean): string {
  return `${name ?? `Species ${speciesId}`}${shiny ? ", shiny" : ""}`;
}

/**
 * A stored item name as a person reads it: `rareCandy` becomes "rare candy".
 *
 * Split out of `shopLabel` rather than copied into the bag. The two surfaces
 * name the same things, and two derivations of one label is how "rare candy" in
 * the shop ends up next to "rareCandy" in the bag.
 */
export function itemLabel(item: string): string {
  return item.replace(/([A-Z])/g, " $1").toLowerCase();
}

export function shopLabel(entry: ShopEntry): string {
  if (entry.kind === "item") return itemLabel(entry.item);
  return entry.tier === null ? "fresh egg" : `fresh egg (${entry.tier}+)`;
}

/**
 * Items the `use` route will accept.
 *
 * A mirror of `HELD_ITEMS` on the server, and deliberately a mirror rather than
 * a fetched fact: `shinyCharm` is passive, so posting it is a 400 and offering
 * the button would be offering a guaranteed error. The server stays the
 * enforcement — this only keeps the panel from asking.
 *
 * Being a mirror, it drifts. The failure is mild in one direction and not the
 * other: an item missing here is one the panel will not offer to spend, which
 * looks like a bug in the bag; an item listed here that the server rejects is a
 * button that always 400s. Both are visible, neither loses anything.
 */
export const CONSUMABLE_ITEMS: readonly string[] = [
  "rareCandy",
  "mint",
  "everstone",
  "lure",
  "sootheBell",
  "incense",
  "repel",
];

/** Rarity filters, with `null` meaning no filter at all. */
export const RARITY_FILTERS: ReadonlyArray<Rarity | null> = [
  null,
  "common",
  "uncommon",
  "rare",
  "legendary",
];

/**
 * How the sprite is behaving, from how long ago this key last earned.
 *
 * Five states, not the spec's six. `focus` is **absent on purpose**: it would
 * have to mean a burst of recent requests, and the plugin stores one instant per
 * key rather than any per-request history, so there is nothing here that could
 * tell a burst from a trickle. A state that never fires is dead code and one
 * that fires arbitrarily is a lie about the key's traffic; either is worse than
 * five honest ones. It arrives the day something records request times.
 */
export type Activity = "egg" | "working" | "idle" | "tired" | "sleep";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function activityOf(hasActive: boolean, lastCreditAt: number | null, now: number): Activity {
  if (!hasActive) return "egg";
  // Null is "never observed earning", which reads as asleep rather than as
  // busy. A save from before the column existed lands here, and so does a key
  // that has only ever been shopped at.
  if (lastCreditAt === null) return "sleep";
  const elapsed = now - lastCreditAt;
  if (elapsed < 5 * MINUTE_MS) return "working";
  if (elapsed < HOUR_MS) return "idle";
  if (elapsed < 8 * HOUR_MS) return "tired";
  return "sleep";
}
