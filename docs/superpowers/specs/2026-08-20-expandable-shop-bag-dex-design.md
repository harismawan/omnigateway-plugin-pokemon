# Expandable Shop, Bag, and Pokédex

**Date:** 2026-08-20
**Status:** implemented in `f0425b3`. Two things changed during implementation and
are corrected below: the catalog holds no `label` column, and the rare-candy
blurb quotes `100.0M` rather than `100M`.

## Problem

The companion panel is one long scroll of four sections that cannot be put away.
The Shop is a wrapped row of buttons reading `rare candy · 500.0M`, and the Bag is
a wrapped row of chips reading `rare candy · 3`. Both name an item and price it
and say nothing about what it does, so the panel is legible only to somebody who
already knows the economy — which is everybody who wrote it and nobody who
inherited it. The Pokédex is a grid of sprites whose captions carry a name and a
nature; the evolution line, the rarity, the shininess and the catch date are all
in the row `readDex` returns and none of them are on screen.

Three changes, one release:

1. Shop, Bag and Pokédex become collapsible, and remember whether they were
   collapsed.
2. Shop and Bag entries become cards on a grid, each with an item icon and a
   sentence saying what the item does.
3. A Pokédex cell expands in place to show that entry's whole record.

## Reference

[PokeTokenBar](https://github.com/chattymin/PokeTokenBar) is the macOS menu-bar
app this plugin's economy was ported from, and it is the reference for the card,
not for the structure. Its shop and bag cards are `[30pt icon] [name + owned
badge] / [description]` over a controls row, and that shape is adopted here.

Its *structure* is deliberately not adopted. It has no disclosure groups
anywhere; hierarchy is a segmented picker over a popover pinned at 520pt. This
panel is a scrolling region inside an ops console with no height budget to
defend, so sections that fold are the right answer here and were the wrong answer
there.

One idiom is adopted and then dropped for the same reason: PokeTokenBar's Dex
detail writes into a fixed-height footer so the grid never reflows. That solves a
fixed-height popover's problem. This panel scrolls, so the detail inserts a row
and pushes the rest down, which is the honest expandable behaviour.

## Server: item sprites

### The map is the security boundary

`ITEM_SPRITE_NAMES` in `src/balance.ts` is a closed literal map from item id to
sprite filename. Nothing a caller sends is ever spliced into a URL — the segment
that reaches the network is a lookup *result*, which is the same guarantee
`spriteBytes` gets from validating an integer against `hasAnimatedSprite`.

| id | sprite | note |
| --- | --- | --- |
| `rareCandy` | `rare-candy` | exact |
| `shinyCharm` | `shiny-charm` | exact |
| `everstone` | `everstone` | exact |
| `sootheBell` | `soothe-bell` | exact |
| `repel` | `repel` | exact |
| `incense` | `luck-incense` | no plain `incense` sprite exists; the plugin's incense weights toward longer lines |
| `lure` | `honey` | no `lure` sprite exists; honey is the in-game encounter-attractor |
| `mint` | `mental-herb` | Gen-8 item, no mint of any flavour in the repository; a green sprig in the same herb art |
| egg, every tier | `lucky-egg` | tier is carried by the rarity chip, not by the art |

`lure` → `honey` is art that names a different item than the label does. It is
accepted knowingly: the alternative for an item with no sprite is no art at all,
and honey is the closest thing in the set to what the plugin's lure does.

**Amended 2026-08-21.** `mint` was originally left absent, on the argument that
no near-miss was worth the same trade — a Heart Scale is a Move Reminder token,
not a nature item. That reasoning holds for the *effect* and is why `mental-herb`
is picked on the picture instead: mints are drawn as green sprigs in game, and
`mental-herb` is that same art. The absence was reversed because of what it cost
in practice. The panel's emoji fallback hid it perfectly, so the only place the
missing icon showed up was a `404` logged to the browser console on every paint,
for a route that was never going to answer — a permanent error an operator has
to learn to ignore, which is how real errors get ignored too.

The map is now **total over `ItemKind`**, and the type says so: a new
purchasable item is a compile error until someone picks art for it. `Partial`
made that omission silent, and silence is exactly what shipped.

Sprites are fetched from `raw.githubusercontent.com`, the origin the manifest
already declares for species sprites. Nothing is vendored, in keeping with the
repository's standing rule about Nintendo and Game Freak assets.

### `itemSpriteBytes`

In `src/pokeapi.ts`, the same shape as `spriteBytes`: read cache, fetch on miss,
write best-effort, return `null` on failure. Cached at
`sprites/items/{name}.png`. An id absent from the map returns `null` before any
I/O, so an unknown item costs neither a fetch nor a disk read.

### `GET /item-sprite/:item`

In `src/server.ts`, alongside `/sprite/:species`:

- 503 when `net` or `files` is undeclared, matching the species route.
- 404 for an id not in the map, and for one whose fetch failed.
- 200 `image/png` otherwise, with the species route's cache headers.

## Panel: one catalog

New `ui/catalog.ts`, one row per item id:

```ts
type ItemCard = {
  blurb: string;
  emoji: string;
  consumable: boolean;
};
```

**No `label` column**, and this was corrected while building it. The draft had
one, which would have re-derived what `itemLabel` already produces for all eight
ids — in the same file that quotes `format.ts`'s warning that two derivations of
one label is how "rare candy" in the shop ends up beside "rareCandy" in the bag.

`CONSUMABLE_ITEMS` **moves** here from `ui/format.ts` for the opposite reason: it
is a fact about an item, so it belongs on the item's row rather than in a second
list that has to be kept in step with this one.

**Copy fails open.** An id the server sells that this table does not know renders
`itemLabel(id)`, no blurb, and the unknown-item emoji. A missing sentence is not
a missing item, and the shop must not lose a row because nobody wrote its
description. This is the `readDex` half of the repository's fail-open/fail-closed
rule, not the `parseState` half: no money moves here.

### Blurbs

Each is the reasoning already recorded in `src/balance.ts`, compressed to a
sentence. They are copy, so they live in the panel; the numbers inside them
(100.0M, 25%, 1 in 48) are duplicated from the server's constants, because the
panel cannot import from `src/`.

`test/catalog.test.ts` is the seam that keeps them honest. A test runs in one
process and can import both halves, so the drift is not prevented but it is
*detected* — at the point somebody changes the balance, rather than months later
when an operator reads a sentence that is no longer true. It caught one on its
first run: the blurb said `100M` while every price on the same card renders
through `formatTokens` as `500.0M`, and a token figure quoted in a different
style from the number beside it reads as a different quantity.

| id | blurb |
| --- | --- |
| `rareCandy` | Injects 100.0M growth. Priced at five times what it grants. |
| `mint` | Rerolls this companion's nature. Cosmetic, and cheap enough to reroll again. |
| `shinyCharm` | Kept, never spent. Raises every future hatch from 1 in 64 to 1 in 48. |
| `everstone` | Pins this companion: it will not evolve, reveal, or graduate. |
| `lure` | Next egg prefers a species the Dex has not collected. A preference, never a veto. |
| `sootheBell` | This companion grows 25% faster. Bound to it, and never repays its price. |
| `incense` | Next egg leans toward a longer evolution line. Buys events, not value. |
| `repel` | Next egg will not hatch one named line. |
| egg, plain | Sends this companion off and starts again. |
| egg, graded | Sends this companion off for an egg guaranteed to hatch *{tier}* or better. |

## Icons, and a rule broken on purpose

`ItemIcon` renders a 32px `image-rendering: pixelated` `<img>` against the
`/item-sprite/` route. On `error` it swaps to the item's emoji.

One path covers both ways the sprite can be absent, which is the reason to build
it this way rather than special-casing any single item:

- A cold cache, where **every** icon is missing on first paint and fills in on a
  later poll. This is the panel's existing stance that a cold cache is an
  ordinary state, not an error — the same stance that lets a species render as
  `#25` until its name arrives.
- An offline or air-gapped install, where the route answers 503 forever.

There was a third — `mint`, mapped to no sprite — until the amendment above.
Both remaining absences are temporary or install-wide; neither leaves one
particular row sitting on its emoji forever. That distinction is the point of
the amendment: a fallback that covers a transient state is a fallback, and one
that covers a permanent state is a bug with a cosmetic lid on it.

Icons are decorative: `alt=""`, and the accessible name of a card is its own
text. An emoji fallback is rendered `aria-hidden`.

### The exception, recorded

`CLAUDE.md` states that colour on this panel means provider identity or state and
nothing else, which is why rarity is letterspaced small caps and shininess is a
glyph. Emoji are full-colour glyphs meaning neither.

The exception is **scoped to item icons and to nothing else**. The argument for
it is that the panel already renders full-colour fetched pixel art in the
companion slot and in every Dex cell, and the emoji stands in that same slot as
the same kind of thing — an illustration of an object, not a claim about state.
It is not licence to colour a rarity, a price, or a health indicator.

This must be written into the founding spec,
[`2026-08-19-pokemon-companion-plugin-design.md`](2026-08-19-pokemon-companion-plugin-design.md),
as an amendment. An amendment nobody wrote
down becomes a rule nobody can check.

## Shop and Bag: cards on a grid

One new `ItemGrid` in `ui/primitives.ts`, used by both sections so the two line
up on the same track:

```
grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
```

260px is derived, the way `RosterGrid`'s 220px was derived from the sprite it has
to hold. A 40-character measure is the comfortable floor for a blurb wrapping to
three lines; at the console's body size that is roughly 234px of text, plus 12px
of card padding and a 1px border on each side. Below that the blurbs become a
column of two-word lines.

```
┌────────────────────────────┐  ┌────────────────────────────┐
│ [icon] soothe bell   3.00B │  │ [icon] rare candy   500.0M │
│                            │  │                            │
│ This companion grows 25%   │  │ Injects 100M growth.       │
│ faster. Bound to it, and   │  │ Priced at five times what  │
│ never repays its price.    │  │ it grants.                 │
│                            │  │                            │
│                    [ Buy ] │  │                    [ Buy ] │
└────────────────────────────┘  └────────────────────────────┘
```

The card is a flex column; the blurb takes `flex: 1` and the action row takes
`margin-top: auto`. Grid stretches cards to the tallest in their row, so without
pinning the action to the bottom every Buy button sits at a different height and
the equal card heights buy nothing.

**Shop cell:** icon, label, rarity chip for a graded egg, blurb, then price and
Buy — or `owned` in place of the price for a held passive.

**Bag cell:** identical, with `×3` where the price sits and `Use` or a dimmed
`held` where Buy sits.

Nothing about *what* is disabled changes. An offer beyond the wallet stays
disabled rather than hidden, because the prices are what an operator saves up
against. An egg with no companion to replace stays disabled for the same reason.
A passive gets no button rather than a disabled one, because a disabled button
says "not right now" and a passive is never spendable at all. This section is
layout; the refusal reasoning is untouched.

## Pokédex: a cell expands in place

The detail is a grid item spanning `grid-column: 1 / -1`, placed in DOM order
immediately after the selected cell. Auto-placement cannot start a full-width
item mid-row, so it drops to the next row line by itself — no column count, no
`ResizeObserver`, no fixed breakpoints, and it keeps working under `auto-fill`.

```
[ #1 ][ #4 ][ #7 ][ #25 ][ #94 ]
[#133][#143][#150][ #6 ][ #9 ]
       ↑ selected
┌──────────────────────────────────────────────┐
│ [96px]  Snorlax  #143                        │
│         RARE · SHINY ✦ · RELAXED             │
│         [sprite] Munchlax → [sprite] Snorlax │
│         caught 14 Aug 2026                   │
└──────────────────────────────────────────────┘
[#196][#197][ … ]
```

Three consequences, stated rather than discovered:

**The selected row goes ragged.** Non-dense auto-flow does not backfill, so slots
to the right of the selected cell stay empty while the detail is open. That reads
as the selection pointing at its own panel.

**The grid reflows vertically**, and here that is correct — see the note on
PokeTokenBar's fixed footer above.

**Selection can go stale.** Changing the rarity filter may remove the selected
entry from what is rendered, so the filter clears the selection. A detail panel
for a sprite that is not on screen is the same class of lie as a bag listing
something it does not hold.

Semantics: `Cell` becomes `<button aria-expanded aria-controls={detailId}>`,
focus stays on the cell when the detail opens, and clicking the same cell again
closes it.

Detail content: the evolution line from `chainOrder`, each stage a sprite from
the existing route with its name falling back to `#id` on a cold cache; rarity,
shininess and nature as the existing `Chip` and `ShinyChip`; and the catch date.

## Collapsible sections

`SectionHead` gains a disclosure:

```
▾ SHOP ──────────────────── 8 offers
▸ BAG ───────────────────── 3 held
▾ POKÉDEX ───────────────── 12 caught
```

The count is what makes a folded section still say what is inside it.

A `<button aria-expanded aria-controls>` inside the existing `h3`, not
`<details>`/`<summary>`. The panel's tests assert visible text, roles and
accessible names, and the rarity filters already establish `aria-*` state on a
button as this panel's idiom.

All three open by default, so first paint is what it is today. State persists to
`localStorage` under `plugin:{pluginId}:sections`, wrapped in `try`/`catch`: a
browser that refuses storage degrades to in-memory state rather than throwing.
Persistence is a convenience and must not be able to take the panel down.

## Testing

Test-first throughout, at the narrowest stable boundary.

**Server** — `test/pokeapi.test.ts`:

- A cached item sprite is returned without touching `net`.
- A miss fetches, returns bytes, and writes the cache.
- An id absent from the map returns `null` with neither `net` nor `files` called.
- A non-2xx response returns `null` rather than throwing.

**Routes** — `test/integration.test.ts`:

- 200 with `image/png` for a mapped id.
- 404 for an unmapped id and for a failed fetch.
- 503 when the capabilities are undeclared.

**Panel** — `test/ui.test.tsx`:

- A disclosure toggles its body and its `aria-expanded`.
- Collapse state round-trips through `localStorage`, and a storage that throws
  leaves the panel working.
- Each item's blurb is visible in the Shop and in the Bag.
- An `img` error swaps the icon to the emoji.
- An item id absent from the catalog still renders a label.
- A Dex cell click reveals nature and evolution line; a second click clears it;
  changing the rarity filter clears it.

Both capabilities stay stubbed. Per the repository's fixture rule, incubated,
earned and spendable each get a distinct value, and no two items in a bag fixture
share a count.

## Files

| File | Change |
| --- | --- |
| `src/balance.ts` | `ITEM_SPRITE_NAMES` |
| `src/pokeapi.ts` | `itemSpriteBytes` |
| `src/server.ts` | `GET /item-sprite/:item` |
| `ui/catalog.ts` | new — labels, blurbs, emoji, `CONSUMABLE_ITEMS` |
| `ui/format.ts` | `CONSUMABLE_ITEMS` removed; `itemSpriteUrl` added |
| `ui/primitives.ts` | `ItemGrid`, `ItemCard`, `ItemIcon`, `DexDetail`, disclosure `SectionHead` |
| `ui/Shop.tsx` | grid of cards |
| `ui/Bag.tsx` | grid of cards |
| `ui/Dex.tsx` | selection and in-grid detail |
| `ui/index.tsx` | disclosure wrappers, persisted section state |
| `test/pokeapi.test.ts`, `test/integration.test.ts`, `test/ui.test.tsx` | above |
| `2026-08-19-pokemon-companion-plugin-design.md` | amendment: the item-icon colour exception, the sprite map, the disclosure structure |
| `README.md` | the new route |

## Out of scope

- Localisation. PokeTokenBar carries four languages; this panel is English and
  the catalog is not a translation layer.
- Item sprites for the roster or the hero. Icons appear in the Shop and the Bag.
- Any change to prices, refusal rules, or what an item does. This release moves
  no money.
