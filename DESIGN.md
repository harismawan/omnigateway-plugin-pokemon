# Pokémon Companion Plugin — Design

Date: 2026-08-19
Status: approved

Depends on: [Plugin Host](2026-08-19-plugin-host-design.md)

## Problem

Token usage is a number. `usage_daily` says 4.1 billion tokens this month and
nobody feels anything about it.

PokeTokenBar — a macOS menu-bar app — makes the number felt by attaching it to a
Pokémon that hatches, grows, evolves, and graduates on the tokens you spend. The
mechanic works because the timescales match: a graduation costs 750M to 6B
tokens, which on one laptop is weeks of real work, so the sprite becomes a
record of effort rather than a progress bar.

OmniGateway already has better data than PokeTokenBar can get. It sees every
request across every provider, attributed to the API key that made it, with
exact token classes and cost, in one database — where PokeTokenBar reverse-
engineers JSONL logs and SQLite caches from ten different CLI tools.

This design ports the game onto that data, as the first plugin.

It is a plugin and not a core feature for three reasons, all of which held
before the host existed: almost nobody deploying an AI gateway wants it, it
depends on two external origins, and it carries third-party IP. See *Non-technical
note*.

## Solution

A plugin at `<root>/plugins/pokemon/` that:

- credits each API key's companion from `RequestCompleted` events
- runs the full PokeTokenBar economy — egg, hatch, evolve, graduate, Dex, shop,
  items, shiny, Ditto disguise, natures, candy grants
- keeps a **per-key** companion and a **per-key** Dex
- proxies and caches PokéAPI data and sprites server-side, so the browser never
  contacts a third-party origin
- ships PokeTokenBar's balance constants as defaults with one operator-tunable
  multiplier

### Decisions carried from the port

| Decision | Choice | Why not the alternative |
|---|---|---|
| Scope | Full economy | A growth-only port loses the shop, which is where accumulated tokens acquire a use |
| Ownership | One companion per API key | The gateway is multi-key; a per-install pet wastes the attribution the gateway already has |
| Dex | Per key | A key is a full save file; rotating one is starting over, which is a real cost the operator controls |
| Assets | Gateway proxies and caches | The dashboard must never add a third-party origin |
| Balance | PokeTokenBar constants + a multiplier | A throughput-derived multiplier makes numbers incomparable across installs and adds a feedback loop |

## Host amendments this plugin requires

Writing this spec against the approved host surface found two gaps. Both are
narrow, both mirror an existing pattern, and both must land in the host before
this plugin can be built.

### `net:outbound` capability

The plugin declares the origins it will contact, in its manifest:

```json
"capabilities": ["storage", "files", "net:outbound", "events:request", "events:limit"],
"origins": ["https://pokeapi.co", "https://raw.githubusercontent.com"]
```

The host hands it a `fetch` bound to that allowlist; a request to any other
origin is refused by the host, not by convention.

This is worth having independently of this plugin. A self-hosted gateway whose
selling point is that prompts do not leave the operator's machine should be able
to state, from one readable file, exactly which outside hosts each installed
plugin talks to. As with every other capability, it constrains honest code and
not hostile code — a plugin sharing the process can call global `fetch`. It is
an auditable declaration of intent.

### `files` capability

The host hands the plugin a scoped directory, `<root>/plugins/<id>/data/`, with
read and write confined to it.

That directory is **excluded from database snapshots**, exactly as
`request_bodies/` is and for exactly the same reason: a snapshot is the database
alone, and a downloaded snapshot's size should not track how many sprites got
cached. After a restore, cached assets and the plugin's rows disagree until the
cache refills, which is expected and self-healing — a missing sprite is
re-fetched.

The alternative — sprite bytes as BLOBs in `plugin_pokemon_*` tables — needs no
new capability and is wrong: it would put tens of megabytes of Nintendo artwork
into every snapshot an operator downloads.

## Storage

Four tables on the plugin's own migration track, named by the host as
`plugin_pokemon_<name>`:

```sql
-- companion: one row per API key
api_key_id    TEXT PRIMARY KEY,
state         TEXT    NOT NULL,   -- JSON: egg or active mon, inventory, eggTier, pendingHatchId
tokens_total  INTEGER NOT NULL DEFAULT 0,   -- monotonic; never recomputed
tokens_spent  INTEGER NOT NULL DEFAULT 0,   -- shop ledger; wallet = total - spent
created_at    INTEGER NOT NULL,
updated_at    INTEGER NOT NULL

-- dex: one row per graduation
id, api_key_id, base_id, final_id, chain_order, rarity, is_shiny, nature, caught_at

-- grants: candy edge-trigger state, keyed on a stable window identity
api_key_id, window_key, granted_tier, PRIMARY KEY (api_key_id, window_key)

-- species: the local PokéAPI index
species_id PRIMARY KEY, capture_rate, is_legendary, chain TEXT, names TEXT, fetched_at
```

The active Pokémon is **JSON**: one row, read and written whole, and its shape
churns with every balance change. The same call `api_keys.limits` already makes.

The Dex is **rows**: it grows without bound, the UI filters and sorts it, and
one corrupt entry must not take the save. PokeTokenBar needs a `Lossy<T>`
decoding wrapper precisely because its Dex is a JSON array; rows give that
isolation for free.

### Failure directions are split on purpose

- **Dex entries fail open.** An unknown `rarity` or `nature` on a historical row
  drops that row from the listing and logs it. A trophy case must not be hidden
  by one bad entry. This is the `isRtkFilterId` precedent.
- **The active Pokémon fails closed.** An unknown `rarity` there selects a
  graduation total — silently changing the game. The companion reads back
  `null`, distinct from "no companion yet", and the UI says the save is
  unreadable. Nothing may collapse that `null` into a default. This is the
  `limits` precedent, including its reason: refuse where a wrong guess is
  invisible.

`rarity` and `nature` rawValues are persisted, so they are a **storage
contract**. Rename or remove only with a migration.

## Growth

`RequestCompleted` carries `apiKeyId` and the four disjoint token classes. On
each event the plugin adds `(input + output + cacheRead + cacheWrite) ×
multiplier` to that key's `tokens_total`, in one statement, and applies the pure
state machine to the result.

Four properties, and the reasons they are properties rather than accidents:

- **Monotonic.** `tokens_total` only ever increases and is never recomputed from
  `request_logs`. `usage.prune(olderThan)` deletes logs, so any design that
  recomputed growth from them would run the meter *backwards* after a retention
  sweep — a Pokémon de-evolving because an operator tidied their database.
- **At most once per request.** `RequestCompleted` is emitted from `finishLog`,
  which already runs at most once per request id. The companion inherits that
  guarantee rather than building a weaker one.
- **From install forward.** A companion is created lazily on the first event for
  its key and starts at zero. There is no backfill, so there is nothing to
  reconcile and no watermark to drift. PokeTokenBar's `installBaselineSet` rule,
  and the reason this plugin needs no read access to `usage`.
- **Loss on crash is acceptable and bounded.** Host events are at-most-once, not
  durable. A crash loses at most a queue's worth of tokens against a 750M
  graduation. Stated so nobody later mistakes this meter for a ledger.

### The multiplier

`config.multiplier`, default `1.0`, applied at credit time.

PokeTokenBar's constants were tuned against roughly 253M tokens/day on one
laptop. A gateway fronting several clients can move that in an afternoon, and
cache reads — which the gateway counts and which are enormous and cheap — push
it further. At `1.0` a busy install graduates Pokémon in days instead of months.

The multiplier is the operator's knob for that, applied to credits and never
retroactive, so changing it never rewrites history or de-evolves anything.
Deliberately not derived from observed throughput: that makes two installs'
numbers incomparable and introduces a feedback loop between playing and pacing.

## The pure core

Game rules live in the plugin's own pure module — no I/O, no clock, no ambient
randomness:

```ts
advance(state, tokensTotal, seed, now) -> { state, events[] }
roll(speciesIndex, seed, constraints) -> speciesId
price(entry) / thresholds(rarity, forms, stage)
```

`now` is a parameter and **the seed is a parameter**. PokeTokenBar rolls against
live randomness, which makes a 1-in-64 shiny and a 1-in-128 Ditto disguise
effectively untestable. Injecting the seed makes every roll reproducible and is
the single largest correctness win available in this port.

The state machine is applied on each credit and on read, so a companion whose
key went quiet still renders correctly without a tick having fired.

### Balance constants

Ported verbatim, with PokeTokenBar's reasoning preserved in comments, because
several of the numbers encode a fixed bug:

- Egg hatches at 5M tokens; the excess carries into the hatchling.
- Graduation totals: common 750M, uncommon 1.875B, rare 3B, legendary 6B.
- Stage cost for form *i* of *k*: `T·i / (k(k+1)/2)`, so total is `T` regardless
  of how many forms a line has, and later stages cost more.
- Rare candy 500M (five times the 100M XP it grants — at parity, buying is free
  growth). Mint 100M. Shiny charm 3B. Fresh egg 1B, with guarantee tiers priced
  by the **graduation-total ratio** (1B / 2.5B / 4B), not the probability ratio.
- Shiny 1/64, 1/48 holding the charm. Ditto disguise 1/128 on common multi-form
  hatches.

**The Ditto reveal.** A disguise is not a costume the companion wears forever: a
Ditto cannot evolve, so the threshold that would have evolved it is the moment it
stops pretending. It becomes Ditto proper — new line, new rarity, `stageIndex`
back to 0 — keeping the shininess and nature that were rolled for this
individual, and carrying the overflow across exactly as an evolution does.
`dittoRevealed` is what keeps it from firing again at every later threshold.

The reveal *replaces* the evolution rather than following it, and the ordering is
the point: run after, a disguise would reach its second form first, and a Ditto
that got to evolve once is a different creature from the one the roll promised.

It needs Ditto's own line and rarity, which live behind PokéAPI — and `advance`
has no capabilities. So it takes the shape `pendingHatch` already established:
the server resolves the answer into `pendingReveal` while the disguise is still
growing, and the transition itself stays local. **A reveal that cannot be
resolved holds at the threshold** rather than evolving or guessing, the same rule
an egg follows when it has met its threshold and has nothing to become. Progress
waits instead of draining, so the reveal happens with its growth intact. The
alternative — hardcoding "Ditto is rare" — would pick the graduation total the
revealed companion carries for life out of a constant, and put a second copy of a
PokéAPI fact in `balance.ts`.

The panel's `?` chip is keyed on `dittoRevealed`, not on the disguise being
present: `dittoDisguise` stays set afterwards because it records what this one
was pretending to be, so a hint keyed on it alone would mark a revealed Ditto as
still hiding something forever.

The fresh-egg pricing comment is the one to preserve most carefully: priced by
probability ratio instead, two uncommon eggs beat one rare egg on *every* axis,
making the higher tier a strictly inferior product. `sortRank` ordering has a
test for the same class of bug, and it ports too.

## Species data and sprites

The plugin owns two proxy routes under its own mount, both inheriting the host's
`requireAdmin` wrapper:

- `GET /api/plugins/pokemon/species/:id` — JSON from the local `species` table,
  fetched from PokéAPI on miss.
- `GET /api/plugins/pokemon/sprite/:id` — bytes from `data/sprites/`, fetched
  from the sprite repo on miss.

`:id` is validated as an integer in range and the sprite variant is an enum, so
no caller can construct an arbitrary outbound URL. Combined with the manifest
origin allowlist, this is not an open proxy.

Assets are fetched once and cached indefinitely — the sprite for #25 does not
change. The species index is prefetched in the background after install so a
roll needs no network at the moment it happens.

**Amendment: the key route warms the names it is about to show.** The prefetch
above is the only thing that ever filled the species cache, and it returns early
once a companion is active — it exists to pre-roll the *next* hatch. So a save
that hatched before its cache was lost could never refill it, and since `data/`
is excluded from database snapshots, every restore produces exactly that: a
hatched companion whose panel read `#11` on every poll for the rest of the
install's life, with nothing able to fix it short of buying a fresh egg.

`GET /keys/:id` now fetches the species documents behind the names it could not
resolve — the active stage first, then unnamed Dex entries — in the background,
capped at eight per poll, deduplicated against what is already in flight, and
skipped entirely without both `net` and `files`. The bound matters: a
long-running install's Dex has a row per graduation, and warming those unbounded
would be a burst fired from a request path. One batch resolves through a single
shared chain cache, because a Dex commonly holds several rows from one evolution
line and `speciesDetail` builds its cache per call.

**A failed warm is remembered, with backoff, and that is a deliberate departure
from how `nameOf` treats a miss.** The first version of this reasoned that a
failure means the network is down and so is a state that ends — the same
argument that makes `names` remember only hits. That argument is false here:
`fetchJson` collapses a 404 and an outage into one `null`, so a species PokéAPI
genuinely has no document for was re-fetched on every poll, at four a minute,
for as long as any operator left the panel open. Worse, since the budget is
eight and `readDex` orders by `caught_at`, eight such rows at the front of the
queue starved every entry behind them for the life of the process — the same
permanent-`#11` failure this feature exists to fix, arriving by a different
route. Failures now back off from a minute to an hour, which costs a handful of
attempts to establish that something is missing and still recovers on its own
from an outage of any length. What counts as failure is "did not yield a name",
not "did not yield a document": a cached species with no English entry parses
perfectly and would otherwise hold a slot forever.

`cachedSpeciesName` is unchanged and stays `files`-only — see the UI section for
why that signature is the guarantee. The roster does not warm at all.

**Hatching must work offline.** PokeTokenBar pre-rolls the next species into
`pendingHatchId` while the egg is still incubating, so the hatch itself is a
local state transition. That ports, and it is what makes the game survive a
gateway with no outbound access.

An air-gapped install degrades **visibly**: the egg stays an egg, the UI says
species data could not be fetched, and no sprite silently renders as a blank
box. A cosmetic feature failing quietly is worse than failing loudly, because
quiet failure gets diagnosed as a bug in the gateway.

## Candy grants

`LimitReached` fires when a key hits one of its own configured rate limits. That
grants candy to that key's companion: one for a session-class window, five for a
weekly-class one.

Rewarding a refusal reads oddly for about a second and then reads correctly —
the key hit its ceiling, which means it worked. It is also the only signal in
the gateway that means "this key ran as hard as it is allowed to."

Two rules, both of which are already-shipped regressions in the source app:

- The edge key is `dimension:window`, which is stable. Never `resets_at` or
  anything else that changes on each evaluation; a rolling weekly window whose
  reset instant moves re-granted at 80, 81, 84… on every refresh.
- Grant state is **persisted** and **seeded on first run**. In memory only, a
  restart re-grants forever. Unseeded, installing the plugin retroactively pays
  out for every window already at its ceiling.

## Key lifecycle

- A companion is created lazily on the first `RequestCompleted` for a key.
- `revoke` is soft — the key row persists — so a revoked key's companion
  **freezes**: visible, no longer growing, Dex intact. It is a finished save,
  not a deleted one.
- Hard deletion cascades, via the host's `ON DELETE CASCADE`.
- `omni plugin remove` leaves every table intact. `--purge` drops them, after
  confirming, because that is irreversible and someone's Dex is in there.

## Shop

`POST /api/plugins/pokemon/keys/:id/purchase` with an entry id.

Wallet is `tokens_total - tokens_spent`. Every purchase does the balance check
and the debit **in one transaction**; checking the balance and then writing lets
two concurrent clicks both pass a pre-purchase snapshot and overspend. This is
the same shape as the rate limiter's synchronous claim, and it fails the same
way if split.

Growth is never rewound. A purchase raises `tokens_spent` only, so the growth
meter is unaffected and no evolution is ever undone by shopping.

`state` mutations from a purchase — a fresh egg discarding the active Pokémon, a
mint rerolling nature, a charm becoming passive inventory — are applied by the
same pure `advance` in the same transaction.

## UI

An ESM bundle built against `packages/dashboard-sdk`, rendered inline under a
"Companion" nav entry, themed with the real dashboard tokens.

- A roster of the keys that have companions; each key is a save file.
- The active sprite with its state — egg, idle, working, focus, tired, sleep —
  derived from recent traffic on that key.
- Growth to next evolution, wallet, and current form.
- Dex, filterable by rarity, showing shiny and nature.
- Shop and bag.

**Amended during implementation: `focus` is not built, and five states ship.**

The other five are derivable from one stored instant — `last_credit_at`, added by
migration 5 and written only where tokens are credited. `focus` is not. It can
only mean a burst of recent requests, which needs per-request history the plugin
deliberately does not keep: growth counters here accumulate precisely because
`request_logs` is pruned by retention and anything derived from it runs backwards
after a sweep.

So `focus` would have had to be either a state that never fires or one that fires
on a threshold with nothing behind it. Five honest states are better than six with
one that means nothing, and a reader of the panel cannot tell the difference from
the outside — which is exactly why it had to be decided rather than approximated.

Building it later is a storage change, not a UI one: it needs a short rolling
count of credits per key, and the natural place is the plugin's own table rather
than anything the host would have to start recording.

**Also amended, twice.** The first amendment said the key selector had to be
free text, because a plugin has no capability to enumerate API keys. That is
still true and it was still the wrong conclusion: it conflated *the host's key
list*, which no capability offers, with *this plugin's own saves*, which it owns
outright. `plugin_pokemon_companion` has one row per key that has ever spent a
token, and `listCompanions` reads it.

So the panel opens on a roster of those rows — sprite, name, key id, lifetime
tokens, activity — and the free-text field survives one fold down, for the two
cases a roster cannot cover: a key minted a minute ago that has no row yet, and
an install whose roster route is unreachable.

The set is smaller than the host's key list and it is the right set. A key with
no companion row has never served a request, so it has nothing to show and a
card for it would lead to a 404. The remaining host gap is only that a companion
cannot be labelled with the key's *name* — the roster shows ids, which is what
an operator matches against the console's own key list.

A roster holding exactly one key opens it without a click, and **that is decided
once, when the roster first arrives** — not re-derived from what the roster
currently holds. Written the second way it fired in both directions every time
the roster crossed the one-key boundary: a companion the panel had opened by
itself closed again the moment a second key earned its first tokens, and since a
purchase refetches the roster, an operator could be thrown back to the picker
mid-transaction. The panel therefore tracks three screens — `start`, `roster`,
`key` — because "the roster has not arrived yet" and "the operator asked to go
back" are different facts that one nullable key id cannot hold apart.

Two facts the roster keeps apart, because everything else in this plugin does:
an egg is drawn as an egg, and a save that could not be read is drawn as neither
an egg nor a species. Dropping the unreadable key from the listing would hide
the one key an operator most needs to find.

All sprite and species requests go to the plugin's own routes. The browser never
contacts `pokeapi.co` or `raw.githubusercontent.com`. **Species names are
resolved server-side and cache-only** — `cachedSpeciesName` takes `files` and
not `net`, so a roster of twenty keys repainting on a poll cannot become twenty
requests against an unpaid public API for decoration. A cold cache shows `#25`
and fills in on a later poll — filled by the key route's bounded warm-up, which
is a separate call and not a fetch smuggled into the name lookup. See the
amendment under *Species data and sprites*.

The panel's one non-obvious element is the **growth track**: the companion's
`plannedPath` drawn as one segment per stage, filled behind the current stage,
carrying real progress on it, empty ahead. A single bar can only answer "how far
to the next evolution"; the track answers "how far through the line", which is
the question somebody watching a companion grow actually has. An egg gets one
segment, because its line is not rolled until it hatches and drawing three empty
ones would be inventing a shape the save does not have.

**Amendment: the sprite has no plate.** It was drawn on `--panel-sunk` inside a
`--rule` border, which is a box *behind* a transparent GIF rather than around
it — in the dark theme that reads as the Pokémon sitting on a black tile, and it
was the one surface on the panel that no data had asked for. The sprite is now
transparent and unframed and takes the card's own background. The egg and the
unreadable mark keep their fill and border, because there the box *is* the
graphic; all three share one size constant, and the marks are `border-box`, so a
card does not reflow the moment an egg hatches.

That constant is **192px and not a rounder number**. The animated Gen-V set is a
96px canvas drawn with `image-rendering: pixelated`, so the scale has to be a
whole number — at 128px, nearest-neighbour renders alternating one- and
two-pixel source pixels and the sprite reads as a broken image rather than a
larger one. `RosterGrid`'s track minimum is derived from it rather than chosen:
192 plus the card's padding and border is 218, so the floor is 220px.

The chip band under the name carries its own vertical margin rather than
borrowing `Row`'s zero, because it is the only row on the panel with a meter
directly beneath it: flush against the growth track the qualifiers read as part
of it, and a chip that wrapped to a second line touched it outright.

**The two facts under the meter each take a line, and this was a real
misreading rather than a cosmetic one.** `Dim` is a span, and JSX strips
whitespace containing a newline, so two adjacent ones rendered with no separator
at all: "Stage 1 of 2" and "76.9M / 250.0M to the next stage" came out as `Stage
1 of 276.9M / 250.0M`, which reads as a companion sitting 26.9M past a threshold
it should already have evolved through. An operator's first conclusion is that
the growth meter is broken. `Fact` is `Dim` set `display: block` for exactly
this pairing.

Worth recording that **no test covers it**: happy-dom performs no layout, so
`textContent` is identical whether the element is inline or block, and the only
assertion that could tell them apart is one about `display` — a component
internal, which the testing rules rule out for good reasons that still apply
here. This is a class of bug this suite cannot catch.

Rarity and shininess are set in letterspaced small caps and a glyph, never a
hue. The console's rule is that colour means provider identity or state, and a
rarity drawn as a colour would be the one decorative colour in the product — and
it would still need the word underneath to be readable. The only `--warn` on the
panel is the unreadable-save mark, which is a claim about health and so is
exactly what the rule permits.

Per the host design, this mount sits inside a React error boundary. A rendering
bug here must not black out the console — the dashboard is what an operator
needs during an incident, and a Pokémon is not.

## Testing

Ported balance tests come first, because each one encodes a fixed bug:
`sortRank` ordering, `phaseThreshold` summing to the graduation total regardless
of form count, and fresh-egg tier pricing never making a higher tier inferior.

Seeded-roll tests assert shiny, Ditto, and rarity-weighted selection against
fixed seeds — impossible in the source app and the reason the seed is injected.

Growth tests: monotonic under a simulated retention prune; exactly one credit
per request id across streaming and non-streaming; multiplier applied to credits
and not retroactively.

Persistence tests: a corrupt Dex row degrades to a shorter list, a corrupt
active Pokémon degrades to `null` and never to a default rarity.

Candy tests: a restart does not re-grant, and installing against windows already
at their ceiling grants nothing.

Concurrency test: two simultaneous purchases against a balance sufficient for
one — exactly one succeeds.

Offline test: with the outbound fetch stubbed to fail, an egg with a
`pendingHatchId` still hatches, and one without reports rather than hangs.

UI tests under happy-dom against a stub plugin module, covering the error
boundary and the unreadable-save state.

## Out of scope

- **Showing a key's console label instead of its id.** Wanted, and not reachable
  from this repository. The host calls it `api_keys.label`, and three separate
  host decisions stand between it and a plugin: `CAPABILITIES` is a closed enum
  with nothing for reading keys, `CORE_TABLES` refuses plugin SQL that names
  `api_keys`, and `RequestCompleted` deliberately carries `apiKeyId` and no
  label — widening that payload is documented there as a security change on the
  same terms as widening `LogFields`. The panel calling the console's own
  `/api/keys` is refused by the SDK and by this plugin's own boundary rule. So
  this needs a host amendment, adding `label` to the event payload and this
  plugin storing it beside `tokens_total` on credit. Until then the card shows
  the id, which is at least the string an operator can match against the
  console's key list.
- Save transfer between PokeTokenBar and this plugin. The state shapes are
  deliberately close enough to make it possible later; it is not a goal now.
- A shared install-wide Dex. Per-key was chosen; a union view can be added
  without a migration.
- Companion state influencing routing, limits, or anything a request depends on.
  This plugin is strictly an observer. Nothing it stores may ever affect what
  the gateway serves.

## Non-technical note

The sprites, names, and evolution data are Nintendo and Game Freak intellectual
property, fetched at runtime from PokéAPI and the community sprite repository.

PokeTokenBar is a personal menu-bar application. Infrastructure that other
people deploy is a different exposure profile. Two choices follow from that and
are load-bearing rather than incidental: this ships as a separately-installed
plugin the operator chooses to fetch, and no asset is vendored into the
OmniGateway npm package or Docker image. Recorded here so the decision stays a
knowing one.
