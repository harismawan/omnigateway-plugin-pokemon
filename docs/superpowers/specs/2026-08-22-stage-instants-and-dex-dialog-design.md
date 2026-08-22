# Stage Instants, and the Dex Record as a Dialog

Two changes that arrived together and are otherwise unrelated. They share a
document because they amend the same two specs and land in the same release, not
because either depends on the other.

Both amend `2026-08-22-pokedex-species-collection-design.md`, which turned the
Dex from a graduation log into a species collection and is the design these
build on. The dialog also overturns a section of
`2026-08-20-expandable-shop-bag-dex-design.md`.

## Part one: a species is dated from when it was reached

### Problem

Making pre-evolutions collectable exposed a fact the previous design did not
notice: **every species on a line carried the same date.** A graduated Venusaur
put Bulbasaur, Ivysaur and Venusaur in the collection and dated all three to the
instant the line finished. A Bulbasaur raised in January read as caught on the
March afternoon its Venusaur graduated.

The collection was saying the whole line was caught in one moment, which is the
one thing it certainly was not — the moments it was actually caught in are the
substance of what a Pokédex records.

### This could not be fixed by reading harder

No amount of derivation recovers it:

- Growth is counted in tokens. No arithmetic over a token total yields a date.
- `last_credit_at` is one instant per key, not one per stage, and is deliberately
  written only where tokens are credited.
- `request_logs` holds instants and is **forbidden as a source here** — retention
  prunes it, and the founding spec's rule against recomputing from it exists
  precisely so a meter cannot run backwards after a sweep.

So the instants have to start being written. Everything below follows from that.

### Storage

`MonState` gains `stageTimes: readonly number[]`, parallel to `plannedPath` up to
`stageIndex`:

- **stamped at hatch** for stage 0, at the transition rather than when the egg
  met its threshold — those are different instants whenever a roll had not landed
  and the egg sat waiting for one;
- **appended at each evolution**;
- **restarted at a Ditto reveal**, because `plannedPath` becomes a different line
  and `stageIndex` resets with it. The growth crosses over; the history does not,
  or the revealed base form would be dated to a stage it never occupied;
- **not touched by an everstone**, which blocks the transition, so there is no
  new stage and nothing to record.

Migration 6 adds `stage_times TEXT` to the Dex, nullable with no default, on the
same reasoning migration 5 used for `last_credit_at`. A graduation recorded
before this column existed has no observed instants, and writing `caught_at` into
every slot would invent a Bulbasaur date out of a Venusaur one. NULL says "never
recorded", which is a fact the panel renders rather than one it papers over.

The graduation event carries the instants out, because graduating discards the
companion — the state that accumulated them is gone by the time the caller sees
the result. That is the same reason `chainOrder` is on the event.

### `advance` takes `now`

This is the existing rule rather than an exception to it: **the clock is passed,
never read.** `now` is used for one thing, stamping, and every transition still
depends only on the stored total — so passing a different `now` changes the
timestamps and nothing else. A retried settle is still the same settle.

### The instant is when we *observed* the stage

The plugin learns about growth when a credit arrives. One large credit that
carries a companion through three stages stamps all three with its own instant,
and that is the honest granularity rather than a defect to be smoothed over.

Interpolating across the gap between credits — spreading the stages in proportion
to the tokens each cost — was considered and rejected. It produces a prettier
timeline out of instants the plugin does not have, which is the plugin inventing
a fact. The equality is recorded in a test so it reads as a decision.

### Fallback, per stage

`Catch` gains `enteredAt: number | null` and `SpeciesRecord` gains
`firstCaughtExact: boolean`. Where no instant was recorded, `firstCaughtAt` falls
back to the graduation and `firstCaughtExact` is false.

**Per stage, not all-or-nothing.** The case that forces it is a companion that
hatched before migration 6 and graduated after it: its `stage_times` covers the
stages it walked since the column arrived and nothing before. Discarding real
instants because their neighbours are missing would be the wrong trade.

The earliest-wins comparison and the catches sort both move to the stage instant,
and this is not a refinement — it is wrong in the *ordinary* case otherwise. A
slow-growing companion reaches Bulbasaur long before a quick one and graduates
long after it, so the two orders disagree exactly when the collection is
interesting. `rarity` moves with `firstCaughtAt` as before, so a record never
shows one catch's date beside another's rarity.

### Panel

`first caught 14 Aug 2026` when the instant is exact, `line graduated 14 Aug 2026`
when it is not. One word, and it buys the difference between a date and the wrong
kind of date. Catch rows follow the same rule per individual.

## Part two: the record is a modal dialog

### What this overturns

`2026-08-20-expandable-shop-bag-dex-design.md` argued for expand-in-place at
length, and the argument was good: `grid-column: 1 / -1` puts the record under
its own cell at any width, under `auto-fill`, with no column count to compute and
no `ResizeObserver` to keep in step with one. It named two costs and accepted
them — the selected row goes ragged, and the grid reflows vertically.

A dialog is out of flow, so **both costs stop existing rather than being
mitigated**. That is the whole case. The clever placement was solving a problem
created by putting the record in the grid at all.

### Native `<dialog>`, opened with `showModal()`

Not a `div` with `role="dialog"`, and the difference is not cosmetic.
`showModal()` puts the element in the top layer — above every stacking context on
the page, with no `z-index` to lose an argument with — traps focus, closes on
Escape, and makes the rest of the document inert. Hand-rolling that is a
well-known way to ship a keyboard trap that only opens one way.

Opened imperatively in an effect rather than with the `open` attribute, because
those are different things: `open` renders a **non-modal** dialog, in flow, with
no focus trap, no Escape, no backdrop and no inertness.

`::backdrop` is styled with `color-mix` against `--panel-sunk` rather than left
to the user agent, whose default ignores the console's theme. A full-viewport
wash is a conspicuous place to break the rule that a hardcoded colour is the one
thing on the page that will not follow the theme.

### Semantics move with it

- The cell stops being a disclosure. `aria-expanded` and `aria-controls` become
  `aria-haspopup="dialog"` — the cell summons something that takes over the page
  rather than revealing a region that stays part of it, and `aria-controls` would
  point outside the grid's subtree.
- `aria-labelledby` points at the species heading, so the dialog is announced by
  species rather than as "dialog".
- **Focus returns to the originating cell**, held by ref. Looking it up again on
  close does not work: the grid re-renders while the record is open — a poll can
  add a species, the filter can remove this very cell — and "the button whose
  accessible name matches" is not a stable handle across that. `close()` restores
  focus itself only for a dialog opened by a form control targeting it; opened
  imperatively, focus lands on `<body>` and the keyboard starts over at the top
  of the console.
- **The rarity filter no longer clears the selection.** That rule existed because
  a detail in the grid was orphaned when a filter removed the cell it sat under.
  A modal has no grid position to be orphaned from, and closing it would discard
  what the operator was reading because they touched an unrelated control. The
  open record is therefore looked up in the whole collection, not in the filtered
  list.
- The backdrop dismisses. The test is `event.target === event.currentTarget` —
  the dialog element's own box *is* the backdrop, and the card inside it is a
  child — which is also what keeps a click on the heading from dismissing the
  record. `contains` would not.

### The record's own layout

Moving the record into a dialog and leaving its layout alone would have been
half the change. What it had was the inline detail's layout — a 96px sprite in a
flex row, everything else stacked in one left-aligned column at a uniform `sm`
gap. That was right for a detail wedged into a grid, where it had to be short.
It is wrong in a dialog: heading, chips, date, evolution line and catch log all
carried the same weight, with nothing saying which was the specimen and which
was the log.

The palette and the typefaces are not this panel's to choose — the console's
custom properties are the contract and there are no webfonts — so the design is
made of **structure and the mono face**, which in an ops console reads as an
instrument readout. That happens to be the Pokédex's own vernacular, so the
constraint and the subject point the same way.

**Two zones, split by a hairline.** A specimen plate — the art at 1:1 on
`--panel-sunk`, with the identity beside it — and a register below it. A rule
rather than a larger gap, because the two are different kinds of thing and a
rule says that where whitespace only says "some distance".

**The art is not resized.** The fetched sprites are a 96px canvas drawn with
`image-rendering: pixelated`, and a record is read up close, so the honest size
is 1:1 and the plate is what gives it presence. This is the only sprite on the
panel that is never scaled, which is why it is the sharpest.

**Labelled fields.** `FIRST CAUGHT` / `EVOLUTION` / `ENCOUNTERS` in the 10px
letterspaced small caps rarity already uses — the panel's existing idiom rather
than a device invented here. It also gives the exact/approximate distinction a
home: the label reads `LINE GRADUATED` instead of `FIRST CAUGHT`, so the
qualifier sits in the structure rather than inside the sentence.

**The signature: the chain, with a you-are-here marker.** The stages were three
sprites `sm` apart, which reads as three unrelated Pokémon that happen to be
adjacent — the one thing a line is not. They are now sunk tiles joined by rules,
and the species whose record this is carries the `--accent` border. That is
*state*, which is what the panel's colour rule permits, and it is the same
accent the open cell in the grid carries so the two read as one idea.

The marker is deliberately not colour alone: the current tile's caption is also
the only one at full `--ink`, and it carries `aria-current`. A marker a screen
reader cannot see is half a marker — and `aria-current` is also the only part of
it a test can assert without reaching into styled-components internals, which
the panel's testing rule forbids.

**Encounters as a table.** A three-column grid — mono date, nature, shiny glyph
— replacing `14 Aug 2026 · relaxed · ✦`. A log is read down a column, and
dot-separated text gives the eye no column to run down. The date column is fixed
in `ch` so the natures line up whatever length the dates render at in the
reader's locale.

**One transition, on open.** 120ms of rise, so a record does not appear as a jump
cut in the middle of the page. Nothing else animates: the chain and the log are
information, and information that moves is harder to read. `prefers-reduced-
motion` turns it off.

The registry number stays `#3` rather than becoming `003`. Zero-padding only
here would break step with the cells and the hero heading, and it would change
the dialog's accessible name for no gain.

### What the tests can and cannot reach

happy-dom implements `showModal()` and `close()`, so open, close, backdrop
dismissal, click-inside-does-not-dismiss and focus restoration are all covered.

**Escape is the user agent's and happy-dom does not implement it.** Rather than
fake it, `onClose` is wired to the element's own `close` event rather than to the
buttons alone — so every route out, including the one the suite cannot press,
goes through one place. That is the mitigation; the gap is stated rather than
hidden.

## Files

- `src/state.ts` — `MonState.stageTimes`, degrading to empty in `parseState`
- `src/advance.ts` — `now` parameter, three stamp sites, `stageTimes` on the
  graduation event
- `src/store.ts` — migration 6, `DexEntry.stageTimes`, `parseStageTimes`
- `src/collection.ts` — `enteredAt`, `firstCaughtExact`, `enteredAtOf`
- `src/server.ts` — passes the event's instants to `recordGraduation`
- `ui/types.ts`, `ui/Dex.tsx`, `ui/primitives.ts` — dialog, dates
- `test/advance.test.ts`, `test/store.test.ts`, `test/collection.test.ts`,
  `test/integration.test.ts`, `test/ui.test.tsx`

## Out of scope

**Backfilling instants for existing graduations.** There is nothing to backfill
*from*; that is the whole premise.

**Interpolating stage instants within one credit.** Rejected above.

**A timeline view.** The instants are now stored, so one could be built. This
change only puts the right date on the record that already existed.
