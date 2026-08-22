# The Pokédex Becomes a Species Collection

## Problem

The Dex is a log of graduations wearing a Pokédex's name. It holds one row per
graduation, orders them newest first, and draws one cell per row. Three
complaints follow from that one fact, and they are the same complaint three
times.

**It omits every species you actually owned.** Graduating a Venusaur means
having hatched a Bulbasaur, grown it into an Ivysaur, and grown that into a
Venusaur. The player watched all three on the panel for weeks. Only the third
appears in the case. A Pokédex that cannot show you a Bulbasaur you raised is
not recording what happened.

**Its ordering is a filing cabinet's, not a Pokédex's.** `caught_at DESC` is the
order an audit log wants. A collection is read by number, and a numbered grid
whose numbers jump around reads as unsorted rather than as chronological.

**The evolution line in the detail captions one stage by name and the rest by
number.** `ui/Dex.tsx` prints `speciesLabel(name, id)` for the stage matching
`final_id` and a bare `#N` for every other, so a Venusaur's detail reads
`#1 → #2 → Venusaur`. That is not a cold cache — the plugin never resolves a
name for a non-final stage at all, so it is permanent. The inconsistency reads
as a rendering bug, which is roughly what it is.

## Reference

The founding design is `2026-08-19-pokemon-companion-plugin-design.md`; its
**Storage**, **Species data and sprites**, and **UI** sections are the ones this
amends. The cell's card treatment, its `SpeciesNumber`, and the expand-in-place
detail come from `2026-08-20-expandable-shop-bag-dex-design.md`, and all of that
survives unchanged — this spec changes what a cell *is*, not how it is drawn.

## Solution

A species collection derived from the graduation log, computed on read.

The key observation is that **the collection is already in the database**. Every
Dex row stores `chain_order`, the whole evolution line the individual was
planned to walk, and `advance` emits `graduated` only when `stageIndex` has
reached the last entry of `plannedPath` (`src/advance.ts:226`). A graduation is
therefore proof that the individual inhabited every species in its
`chain_order`. Expanding that column is not an inference about what probably
happened; it is a reading of what the row already says.

Three consequences worth stating before the detail:

**No migration, and no backfill.** Nothing is written differently and no column
is added. The plugin has a standing rule against backfill — a companion measures
from install forward — and this respects it by not needing one: every
graduation already recorded, however old, lights up its whole line the first
time the new code reads it.

**The economy does not move.** `collectedFinals` (`src/server.ts:367`) still
means "lines this key has graduated", built from `final_id` alone. It is read by
the diversity weighting and by the lure's hard filter, and widening it to "any
stage I have seen" would make the lure skip every line the player had partly
walked — much stronger for an hour, then useless. Collection is a display fact.
Rolling is not.

**`readDex` is unchanged.** The ascending sort happens in the derivation, not in
SQL, because the sort key is a species id that does not exist as a column — it
comes out of expanding `chain_order`. So the `dex_by_key` index stays correct
for the query it was built for, and the one caller that wants raw graduation
rows still gets them.

## `src/collection.ts`

A new module, pure, taking rows and returning records. It sits beside `advance`,
`roll` and `balance` for the reason those are separate from `store`: it can be
tested exhaustively without a database, a renderer, or a capability stub.

```ts
export type Catch = {
  /** The Dex row's id, so a catch list has stable React keys. */
  id: string;
  /** The line this individual walked. On the catch, not the species — see below. */
  chainOrder: readonly number[];
  isShiny: boolean;
  nature: string | null;
  caughtAt: number;
};

export type SpeciesRecord = {
  speciesId: number;
  rarity: string;
  /** True when *any* catch that put this species in the collection was shiny. */
  isShiny: boolean;
  firstCaughtAt: number;
  /** Newest first, the order the log this replaces was read in. */
  catches: readonly Catch[];
};

export function collect(entries: readonly DexEntry[]): SpeciesRecord[];
```

### The rules, and why each is the one chosen

**Every member of `chain_order` is a caught species.** Justified above. Note the
direction of the guarantee: it holds because graduation is the only event that
writes a row, so a partially-walked line is never recorded at all. A companion
abandoned at Ivysaur contributes nothing, which is correct — it has not
finished, and the panel already shows it as the active companion.

**`isShiny` is true if any contributing catch was shiny.** Shininess is a
property of an individual and does not change as it evolves, so a shiny Venusaur
graduation is proof of a shiny Bulbasaur owned. The alternative — the newest
catch wins — was rejected because it *removes* a shiny from the collection when
a later ordinary individual of the same line graduates, and a collection that
can lose something is not a collection.

**`firstCaughtAt` is the earliest contributing catch.** "First caught" is the
fact a Pokédex records.

**`rarity` comes from the earliest catch.** Every stage of a line shares one
rarity by construction — `SpeciesCandidate` documents why only base forms are
rollable, and rarity is read from the rolled base's capture rate — so this rule
only ever decides a tie that a corrupt row could invent. It is written down
because "they are always equal" is the kind of assumption that stops being true
without anybody noticing, and an arbitrary winner is worse than a stated one.
Earliest, rather than rarest, because it is derived from stored facts alone and
so is stable across reads: the same rule that makes a retried roll the same
roll.

**And "earliest" needs a tie-break, or it is not a rule.** Two graduations land
in the same millisecond whenever a large credit carries a companion through
several lines at once — the collision `dexId` mixes a counter in to survive —
and `readDex` orders by `caught_at DESC` with no secondary key, so on a tie the
row order is SQLite's to choose. A strict `<` would hand `rarity` to whichever
it chose, which is exactly the arbitrary winner the paragraph above disclaims.
The tie goes to the lower id, compared by code unit rather than through
`localeCompare` — that one reads the runtime's default collation, which would
make the tie-break a property of the host rather than of the data. The same
comparison orders `catches`, for the same reason: not because it is
chronological, which nothing can recover, but because it is the same on every
read, so a detail does not reshuffle on a poll.

`firstCaughtAt` and `rarity` are therefore decided together, from one row.
Taking the timestamp from one catch and the rarity from another would describe
an individual that never existed.

**`catches` is newest first, and the output is sorted by `speciesId`
ascending.** Two different orders for two different things. The grid is a
collection and reads by number; a species' own history is a log and reads newest
first, which is the order `readDex` already returns and so is free.

**`chainOrder` stays on the catch, never on the species.** This is the one rule
that is not obvious, and Eevee is why. Its chain branches nine ways, so
`lineThrough` gives a Vaporeon catch `[133, 134]` and a Jolteon catch
`[133, 135]`. Hoisting a line onto the Eevee record would silently pick one
winner and print "Eevee → Vaporeon" over a Jolteon the player also owns. Left on
the catch, the detail can draw each *distinct* line among the catches — distinct
by the members in order, so two catches that walked `[133, 134]` draw one line
between them — giving one line for almost every species, two for a branched
Eevee, and no lie in either case.

**Failure direction: fails open, inherited.** `readDex` already drops a row
whose `chain_order` will not parse and returns the rest. `collect` adds no
second gate, because there is nothing left to reject — it consumes typed rows.
A species that appears in no surviving row is simply absent from the collection,
which is the same gap `readDex` already leaves and the same trade the founding
spec's **Failure directions are split on purpose** section describes.

## Server

`GET /keys/:id` sends `collect(readDex(...))` in place of the graduation array,
with a name resolved per species through the existing cache-only `nameOf`.

The useful consequence, and the reason the evolution-line bug needs no new
fetching: **every species an evolution line can draw is itself in the
collection.** A line drawn in the detail comes from some catch's `chainOrder`,
and every member of every `chainOrder` is expanded into a record by definition
of `collect`. So the payload already carries a name for each of them, and the
panel indexes names by species id off the array it was handed. No second lookup,
no route, no extra request.

`warmNames` is fed every un-named species in the collection rather than only the
finals. That is a larger set — up to three times, for an install full of
three-stage lines — and the founding spec's warming section already covers the
consequences: `WARM_PER_POLL` stays at eight, `cold` still skips a permanently
missing species without consuming a slot, and the ordering the queue is built
from is now ascending by number rather than by catch date. Deterministic and
front-loaded on the low numbers, which is as good a priority as any and better
than "whatever graduated most recently".

### Wire shape

`ui/types.ts` is hand-written against this and the integration suite asserts it
from the server's side, which is the arrangement that keeps the two halves
honest. `DexEntry` becomes `DexSpecies`:

```ts
export type DexSpecies = {
  speciesId: number;
  rarity: Rarity;
  isShiny: boolean;
  firstCaughtAt: number;
  catches: Array<{
    id: string;
    chainOrder: number[];
    isShiny: boolean;
    nature: string | null;
    caughtAt: number;
  }>;
  /** Resolved from the plugin's own species cache, so null on a cold one. */
  name: string | null;
};
```

Nested rather than two parallel arrays. A `dex` history plus a `species` roll-up
would duplicate the payload and create two shapes that have to agree, and the
one that drifts is the one nobody is looking at.

## Panel

The cell keeps its card, its `SpeciesNumber`, its expand-in-place detail, and
the rarity filter — a species inherits its line's rarity, so the filter needs no
change at all. What changes is what a cell counts and what it says.

```
┌───────────┐
│  [sprite] │
│    #003   │
│  Venusaur │
│   ✦ × 2   │
└───────────┘
```

**The sprite is the shiny variant when `isShiny`.** One species owned both shiny
and not draws the shiny one, following the roll-up.

**`✦` marks shininess and `× 2` counts catches, the count shown only above one.**
The glyph rather than a colour, because the panel's rule is that colour means
provider identity or state and nothing else, and shininess is neither. `× 1` is
suppressed because a count that is always there stops being information.

**Nature leaves the cell.** It is a property of an individual, and a cell is now
a species. It moves into the detail's catch list, where each catch carries its
own.

The record's title is an `h4` rather than the `strong` it replaces, and the rank
is not the point — the role is. `SectionHead` and `HeroName` are both `h3`, so a
record opened inside a section nests correctly, and what the promotion buys is a
`heading` role whose accessible name is the concatenation of both slots. That is
what lets `#3 Venusaur` be asserted as one fact rather than as two `getByText`
calls that would pass with the number rendered anywhere on the page. The hero
heading is asserted the same way for the same reason.

The detail gains a catch list and loses nothing:

```
┌──────────────────────────────────────────────┐
│ [96px]  #003 Venusaur                        │
│         RARE · SHINY ✦                       │
│         first caught 14 Aug 2026             │
│         #1 Bulbasaur → #2 Ivysaur → #3 Venusaur │
│         ─────────────────────────────────    │
│         14 Aug 2026 · relaxed                │
│         19 Aug 2026 · timid · ✦              │
└──────────────────────────────────────────────┘
```

**Every stage of the line is captioned with both its number and its name**, and
that is the third complaint fixed. It is the rule the hero heading and the cell
already follow — number always, name when there is one — rather than
`speciesLabel`, which is for a single slot holding whichever of the two exists
and would print `#1 #1` on a cold cache. A stage whose name has not resolved
shows its number alone and fills in on a later poll, which is the ordinary cold
state and not an error.

The `final_id`-comparison that used to decide which stage got the name is
deleted along with the asymmetry it enforced. Its comment warned that captioning
by position would print "Vaporeon" under an Eevee; naming every stage from its
own id cannot make that mistake, and the per-catch line makes the branch itself
visible.

Section count and empty state stop saying "graduate": `N species`, and "Nothing
caught yet." The filter's empty state keeps its shape — "No `<rarity>` species
yet." — because the distinction it exists to draw, between a filter that hides
everything and a case that is empty, is unaffected.

## Testing

Test-first, at the narrowest stable boundary, as everywhere else here.

**`test/collection.test.ts`** — new, pure, no database and no renderer:

- a single three-stage graduation yields three records, ascending by number
- a species reached by two catches yields one record with two catches
- `isShiny` is true when only one of several catches was shiny
- `firstCaughtAt` is the earliest, not the newest
- `catches` comes back newest first
- a branched Eevee keeps both lines, one per catch
- `rarity` follows the earliest catch when two rows disagree
- an exact `caughtAt` tie resolves the same way whichever order the rows arrive
  in — asserted both ways round, because a rule that depends on input order
  passes whichever direction the fixture happens to use
- an empty input yields an empty collection

Every quantity in every fixture gets a distinct value — a fixture that gives the
species id, the catch count and the timestamp one number passes whichever two
the code confuses.

**`test/integration.test.ts`** — the `dex` wire shape and its ascending order,
asserted from the server's side, since that is what keeps hand-written
`ui/types.ts` honest.

**`test/ui.test.tsx`** — under happy-dom, asserting visible text and accessible
names and never a class name:

- a cell renders both its number and its name
- **every** stage of the evolution line renders both its number and its name —
  the regression test for the third complaint, and the one that would have
  caught it
- a species with two catches shows `× 2`; one with a single catch shows no count
- each catch's history row carries **its own** date, not the species'
- the section count reads in species

## Files

- `src/collection.ts` — new; `collect`, `SpeciesRecord`, `Catch`
- `src/server.ts` — `GET /keys/:id` sends the collection; `warmNames` is fed
  from it
- `ui/types.ts` — `DexEntry` becomes `DexSpecies`
- `ui/Dex.tsx` — cell and detail
- `ui/index.tsx` — section count
- `ui/primitives.ts` — a catch-list row, if the existing primitives do not cover
  it
- `test/collection.test.ts` — new
- `test/integration.test.ts`, `test/ui.test.tsx` — updated

No change to `src/store.ts`, `src/advance.ts`, `src/roll.ts`, or the migration
list.

## Out of scope

**Empty slots for uncaught species.** A real Pokédex shows #1 to #649 with gaps.
That needs the full species list on the client, 649 sprite requests against a
cache built for what the player owns, and a completion meter — a different
feature that this one does not block.

**A per-species "seen but not owned" state.** There is no event that would write
one. A species is in the collection or it is not.

**Sorting or grouping other than by number.** The rarity filter already covers
the one narrowing anybody asked for.
