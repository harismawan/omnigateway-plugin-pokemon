# A Pokémon Counts Before It Graduates

## Problem

The Pokédex could only speak about lines that had **finished**. A companion
half way up its line had been a Bulbasaur for weeks and an Ivysaur for weeks
more, and the collection said nothing about either until the day it graduated.

That followed from where the data lived. `{{dex}}` holds one row per graduation
and nothing else writes to it, so the species collection — derived by expanding
`chain_order` — could only ever contain species from completed lines. The rule
was written down in `src/collection.ts` and it was honest about the gap:

> a companion abandoned half way up its line contributes nothing, since
> graduation is the only event that writes a row at all.

Second complaint, and it is the same one from the other side: a record drew
**every** stage of its line, including forms the key has never reached. A
Pokédex entry for a Venusaur nobody has ever owned, with a name and a sprite,
indistinguishable from one that was earned.

## The decision that shaped this

An in-progress companion can be thrown away. `applyPurchase` discards it
outright when a fresh egg is bought, and that is deliberate — a reroll.

So a collection that included in-progress species had two options and they pull
against each other:

**Derive from the live companion.** No storage. The species appear while the
companion lives and vanish when it is rerolled. A collection that can lose
things, which is the property the shiny rule was written to prevent.

**Record on sighting.** The species persist. But rerolling becomes a way to
acquire collection breadth, which the shop's own comment says it prevents.

**Recording was chosen, and the farming concern turns out to be small.** A
reroll costs `FRESH_EGG_BASE_PRICE` — 1B — plus `EGG_HATCH_THRESHOLD`, 5M, to
hatch the replacement. That is ~1B **of wallet** per species. Graduating a
common line costs 750M of *growth* for three species, or 250M each, and spends
no wallet at all. Farming is roughly four times worse per species, in a currency
the natural path does not spend.

What it does mean is that the shop's claim needs narrowing from "cannot farm the
collection" to "is a bad way to farm the collection". That amendment is made
rather than left to rot, because a comment that is false is worse than no
comment.

## `{{sightings}}`, migration 7

```sql
CREATE TABLE {{sightings}} (
  api_key_id  TEXT NOT NULL,
  species_id  INTEGER NOT NULL,
  chain_order TEXT NOT NULL,
  rarity      TEXT NOT NULL,
  is_shiny    INTEGER NOT NULL DEFAULT 0,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, species_id)
)
```

**A fourth table rather than a nullable `caught_at` on `{{dex}}`**, and the
reason is blast radius. `readDex` and `collectedFinals` both assume every row
they see is a graduation. A sighting row living there would need a guard at
each, and a guard missed once feeds the roll's diversity weighting and the lure
with species nobody graduated — the economy rather than the panel. A separate
table cannot be read by accident.

**Keyed on the species, not the individual.** That is the question it answers —
"has this key ever been a Bulbasaur" — and it is what makes the write an
idempotent `INSERT … ON CONFLICT DO NOTHING` rather than a read-modify-write.
First sighting wins and is never updated, the same monotonic rule the growth
counters follow.

**`chain_order` is carried** because a species seen but never graduated has no
Dex row to take a line from, and a record with no line is a sprite with nothing
under it.

## Writing

`recordSightings` is called from `settleAndRecord` **on every settle**, not from
`hatched` and `evolved` events. Events would be fewer writes and would miss the
case that matters most: a companion already half way up its line when this ships
would go unrecorded until its next evolution, which on a quiet key is weeks.
Writing what is currently true self-heals on the next poll instead, and costs at
most three no-op inserts against a primary key.

It records `plannedPath.slice(0, stageIndex + 1)` — exactly what this individual
has been. The stages ahead are a plan rather than a history.

Each stage takes its instant from `stageTimes`, **not** from `now`. This runs on
every settle, so `now` is whenever the panel last polled; taking it would date
every stage of every companion alive today to the first poll after this ships.
`now` is the fallback for a companion that hatched before stage instants existed
and therefore has a shorter `stageTimes` than `plannedPath` — late, but the only
instant anybody has for it.

**A disguised Ditto records nothing.** The plugin knows it is a Ditto. Recording
the disguise would put a species in the collection that was never really there,
and the reveal would then have to take it back out — which this table has no way
to do, by design. On reveal the real line starts recording normally.

**`collectedFinals` is untouched** and still built from `readDex` alone.

## Reading

`collect(dexRows, sightings)` merges the two. A species can arrive from either
source or both, and the merge is a *comparison* rather than a preference for
whichever list is read second — a graduation earlier than a sighting still dates
the species. Order is therefore not load-bearing *for dating a species*, which is
what makes it safe to fold sightings in after the graduations. It is load-bearing
for `lines`, which is offered in source order — see the amendment below, which
corrects the flat "order is not load-bearing" this paragraph used to claim.

A sighting adds **no catch**. An encounter is a completed line and this species
has not been on one; inventing an entry would claim a graduation that has not
happened.

`SpeciesRecord` gains `lines`, the distinct evolution lines this species has
been on, deduped by members-in-order. **Computed in `collect` rather than in the
panel**, because it is a fact about the data: a sighting-only species has no
catch to derive a line from, and a panel deriving lines from `catches` alone
would draw that record with nothing under the sprite. The sighting's line is
offered last and only lands if the catches did not already cover it, so a
species with both a graduation and a live companion on the same chain draws one
line rather than two identical ones.

### Amended 23 Aug 2026: one fold, and one seam

The two rules above are unchanged and the stored shape is untouched. What changed
is that `collect` no longer walks the sources in two passes.

Each source is reduced to a `Contribution` — the species, what dates it, whether
that date is an observation or a stand-in, and the individual behind it or null —
and one loop folds them. The first-wins comparison, the shininess OR and the
rarity tie-break existed once per pass before this, and keeping two copies in
step by hand is a correction applied to one of them being a bug waiting in the
other.

`lines` is deduped as the fold runs rather than by a `linesOf` helper afterwards.
"The sighting's line is offered last" is now a property of the concatenation —
graduations before sightings — rather than of a separate step, and the resulting
array is the same in both order and members. `{{sightings}}` is keyed
`(api_key_id, species_id)`, so a species contributes at most one sighting line
and there is nothing for a second one to reorder.

**`readCollection(storage, apiKeyId)` is now the only supported way to read a
collection.** It reads both tables and hands their rows to `collect`. Assembling
the pair at a call site is what it exists to prevent: a caller that read the Dex
and forgot the sightings would render a panel short by every species whose
individual has not graduated yet, with nothing on it to say so.

It lives in `src/collection.ts` and not in `src/store.ts` because the dependency
has to point one way — `store` importing `collect` back would be a cycle.
`collect` stays exported and pure, so the rules are still tested against arrays
rather than against a database.

`DexEntry` and `Sighting` now share an `Observed` base — `chainOrder`, `rarity`,
`isShiny`, the three fields both genuinely have. It is a shared base and **not**
a merged type, for the reason the two tables were kept apart in the first place:
flattening them would give every sighting a nature column that is always null.
The reader-side `chain_order` parse is likewise one `parseChain` rather than two
copies, so a `readDex` that dropped a chain `listSightings` kept can no longer
put a species in the collection its own detail dialog cannot draw.

None of this reaches `collectedFinals`, which is still built from `readDex`
alone. That invariant is what the separate tables buy and the refactor does not
spend it.

## Panel

**Unobtained stages are hidden**, which needs no server field: the obtained set
is `entries.map(e => e.speciesId)`, built from the whole collection rather than
the filtered view, for the same reason the name index is. Filtered *before* the
map so the chain links land between surviving stages rather than leaving a rule
pointing at nothing.

For a graduated line every stage is in the collection, so this filters nothing
and the chain is unchanged. The hiding only bites for a line still being walked,
which is exactly the case it was asked for.

**The encounters field is omitted when there are none**, rather than shown with
a count of zero. A heading over an empty list reads as a list that failed to
load.

Nothing distinguishes a sighting-only cell from a graduated one in the grid.
That was a deliberate choice: a species is in the collection or it is not.

## Testing

- `test/store.test.ts` — reached stages only, instants from `stageTimes` not
  from `now`, the `now` fallback for a short `stageTimes`, first sighting wins
  on a repeat, a disguised Ditto records nothing, the line is carried, key
  isolation, and a corrupt chain costing its row and not the listing.
- `test/collection.test.ts` — a sighting-only species is in the collection with
  no catches; the merge in both directions; shininess from either source;
  species order across both sources.
- `test/integration.test.ts` — a companion still growing appears without the
  stages ahead of it, dated from when each stage was entered; a disguised Ditto
  stays out; **a species survives its companion being rerolled away**, which is
  the trade this design made.
- `test/ui.test.tsx` — an unreached stage is hidden, a fully-reached line still
  draws every stage, and the encounters field is omitted when empty.

## Files

- `src/store.ts` — migration 7, `Observed`, `Sighting`, `ReachedStages`,
  `recordSightings`, `listSightings`, `parseChain`
- `src/collection.ts` — merges sightings, computes `lines`, `readCollection`
- `src/server.ts` — records on settle, reads the collection through
  `readCollection`
- `ui/types.ts`, `ui/Dex.tsx` — `lines`, hidden stages, omitted encounters

## Out of scope

**Marking an in-progress species differently in the grid.** Considered and
declined: a species is in the collection or it is not.

**Removing a sighting.** There is no path that should. A species this key has
been is a fact about the past, and the table has no update or delete by design.

**Letting sightings feed the economy.** Stated here so it is a rule rather than
an omission: `collectedFinals` means graduations, and widening it would let a
reroll move the roll's odds.
