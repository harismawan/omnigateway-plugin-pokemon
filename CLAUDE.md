# Pokémon Companion Plugin — Repository Guidance

Agent guidance for repository work: boundaries, conventions, and durable traps. `README.md` serves
operators and plugin authors; `docs/superpowers/specs/` holds the designs and every amendment to
them; this file serves contributors. Update all that a change affects — the spec in particular,
because an amendment nobody wrote down becomes a rule nobody can check.

Specs are named `YYYY-MM-DD-<topic>-design.md` and dated by when they were written, not by when the
work landed. The plugin's founding design is
`docs/superpowers/specs/2026-08-19-pokemon-companion-plugin-design.md` — formerly `DESIGN.md` at the
root — and it is where an amendment to the plugin's *existing* behaviour belongs. A new feature gets
its own spec, and amends the founding one where it changes something already recorded there.

Rules here are carried over from the OmniGateway monorepo's own `CLAUDE.md`
(`../omnigateway/CLAUDE.md`), which is the parent project this plugin installs into. Its
gateway-specific sections — provider adapters, routing, client contracts, CLI root resolution,
usage rollups — are deliberately absent: none of those directories exist here. What remains is what
governs work in this repository, plus the invariants this plugin has of its own.

## Scope

A single-package Bun/TypeScript plugin for [OmniGateway](https://github.com/harismawan/omnigateway).
It is an observer: nothing it stores may affect routing, limits, or anything a request depends on.

- `src/` — the server half, loaded into the gateway process
- `ui/` — the panel bundle, built against `@omnigateway/dashboard-sdk` and loaded by the console
- `test/` — server suites plus one happy-dom UI suite
- `scripts/build-package.ts` — assembles `dist/pokemon`; never hand-edit `dist`

## Commands

```bash
bun install
bun test ./test/*.test.ts   # server suites
bun run test:ui             # panel, under happy-dom
bun run typecheck
bun run lint                # biome check
bun run fmt
bun run build               # writes dist/pokemon
```

Before claiming completion, run the focused changed-behaviour tests, both suites, `bun run
typecheck`, and `bun run lint`. State the result; do not describe work as done on the strength of
having written it.

Pushing a `v*` tag runs `.github/workflows/release.yml`; the tag is the sole version source.

## Boundaries

1. Import `@omnigateway/plugin-api/define`, never the package root. The root re-exports the manifest
   schema and with it zod — half a megabyte of validator bundled into a plugin that wanted an
   identity function and some types.
2. Capabilities arrive as arguments. Nothing in `src/` reaches for `fetch`, `process`, or a
   filesystem module, which is why no test can touch the network or a real directory by accident.
3. A capability the manifest does not declare is absent from the context, and code must degrade
   rather than throw: no `net` means an egg holds its progress and the sprite route answers 503, and
   no `channels` means nothing is pushed and the panel falls back to its ten-second poll. A member
   added to a capability without a generation bump — `PluginChannel.broadcast` is the one — is
   feature-detected and falls back, because a manifest cannot ask for it.
4. The manifest is a guardrail, not a sandbox. A plugin shares the gateway's process and can import
   past all of it. What the declaration buys is that accidental overreach is impossible and that
   intent is auditable from one readable file.
5. The panel talks to its own backend through the SDK's `api`, which is bound to
   `/api/plugins/pokemon/`. It does not reach the console's own API, and a path that tries is
   refused rather than normalised.
6. **One installation is several replicas.** Every storage call is asynchronous, SQL is written in
   the `$1` dialect both SQLite and Postgres accept, and every write to `{{companion}}.state` goes
   through `writeState` — a compare-and-swap against `CompanionRow.raw`, the stored text. Never
   re-serialise the parsed state as the expected value: `parseState` clamps and defaults, so a save
   that round-trips to different bytes would never match itself. A lost swap is reported, never
   retried, except the candy grant, whose window is already claimed. Design:
   `docs/superpowers/specs/2026-09-03-multi-pod-deployment-design.md`.
7. Nintendo and Game Freak assets are **never vendored** — not into the repository, the npm package,
   or any built artifact. They are fetched at runtime and cached in the plugin's scoped data
   directory.

## TypeScript and panel style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, including tests. Use `unknown` plus narrowing or named types.
- ESM imports with explicit `.ts` / `.tsx` extensions. Match nearby naming and comment density —
  this codebase explains *why*, not *what*, and a change that drops the reasoning is a regression.
- Biome: 2-space indentation, 100-column lines. Avoid unrelated refactors.
- The panel uses styled-components, never Tailwind or CSS files.
- Style only with the console's CSS custom properties. `CSS_VARIABLES` in the SDK is the list
  guaranteed to be defined in both light and dark; a hardcoded hex is the one thing on the page that
  will not follow the theme.
- **Colour means provider identity or state, and nothing else.** Rarity and shininess are set in
  letterspaced small caps and a glyph for this reason. `--warn` on the panel marks a save that could
  not be read, which is a claim about health and so is what the rule permits.
- Prefix transient styled-components props with `$`.
- No webfonts. A plugin bundle that ships a font file downloads a megabyte to render a token count.

## Testing

- Test-first. Write the failing test, watch it fail for the reason you expect, then implement.
- Prefer behaviour tests at the narrowest stable boundary. Pure logic (`advance`, `roll`, `balance`,
  `activityOf`) is tested without a renderer or a database.
- `test/helpers/storage.ts` mirrors the host's storage rules, **including its core-table denylist
  and its hand-rolled `BEGIN`/`COMMIT`** — `db.transaction` takes a synchronous function and would
  commit before an awaited statement ran. It does not share them. `@omni/store`
  is unpublished, so an external plugin cannot test against the code that will run its SQL. When the
  host's rules change, that mirror must change with them or migrations pass here and fail at boot.
  `src/push.ts` is the same arrangement for `apps/gateway/src/stream/coalescer.ts`: a mirror of an
  internal module, floors included, that hears nothing when the original moves.
- The integration suite drives a fixture clock while the pusher arms real timers, so the two agree
  only while nothing is pending. A test that wants a distinct frame moves `clock` past
  `PUSH_FLOOR_MS` first. Coalescing itself belongs to `test/push.test.ts`, which controls both.
- Stub both capabilities. A test that reaches PokéAPI is testing PokéAPI.
- Panel tests run under happy-dom via `bun run test:ui`, kept out of the server run because
  registering a DOM mutates process-wide globals. Assert visible text, roles, and accessible names —
  never class names or component internals.
- Give each quantity in a fixture a distinct value. A fixture that gives incubated, earned, and
  spendable one number passes whichever two the component confuses.

## Security and privacy

- Never log prompt or response bodies, credentials, or arbitrary headers. `PluginLogFields` is a
  closed allowlist, not `LogFields`; the host binds `plugin` itself and sanitises `event`.
- The plugin never holds a session credential. Panel requests are same-origin with an HttpOnly
  cookie it cannot read.
- Every route under the plugin's mount inherits the host's `requireAdmin` wrapper.
- Ids that become a URL segment or a filename are validated as integers in range first, so no caller
  can construct an arbitrary outbound URL or cache path.
- A UI-side allowlist (`CONSUMABLE_ITEMS`) is a convenience that keeps the panel from asking for a
  guaranteed error. The server stays the enforcement; never move a rule out of it.

## Data traps

- **"Unreadable" and "has not started" are different facts, everywhere.** `parseState` returns null
  for a save it cannot read, and nothing may replace it with a fresh companion — that is the one
  irreversible thing this plugin could do to months of growth, and it would do it silently. The
  panel and the roster each draw it as its own state, never as an egg.
- **Fail open for history, fail closed for money and for the active companion.** `readDex` and
  `listCompanions` drop or flag a bad row and return the rest; `parseState` and a purchase refuse
  outright. The contrast is deliberate. It follows the host's `isRtkFilterId` precedent.
- Growth counters only ever increase and are never recomputed from `request_logs`: retention prunes
  that table, and a recomputed meter runs backwards after a sweep — a Pokémon de-evolving because an
  operator tidied a database.
- **A frame is broadcast, not sent per connection.** A `connectionId` is meaningful only on the
  replica whose socket produced it, so `send` reaches the panels that happen to share a pod with the
  code calling it. The pusher takes `broadcast` when the host has it and gives up "no audience, no
  work" in exchange: this process's listener set says nothing about the fleet's.
- **A frame goes out on every write to `{{companion}}` and on no read.** Both halves are
  load-bearing. The panel turns its poll off while the channel is pushed, so a write that does not
  push is a screen that stops updating with nothing to correct it — and a read that pushes is a
  refetch loop, because `GET /keys/:id` settles on the way in. When you add a write, add the
  `push`; `settle` reports `wrote` so no call site has to guess.
- **`advance` returns the state object it was given when nothing changed**, and `settle` reads that
  identity to decide whether to write. It is not a micro-optimisation: the guard was dead once —
  `advance` opened by allocating unconditionally — so the plugin wrote a row on every read, and the
  push invariant above could not have been expressed at all.
- Push frames name a key and never carry the companion. Push and poll must end in the same fetch and
  the same serialiser, which is the rule the console's own `res:*` topics follow.
- Anything on the channel is reachable by any admin panel in the console, which can spell the topic
  itself. Nothing may ride it that is not already admin-reachable through this plugin's own gated
  routes.
- `last_credit_at` is written **only** where tokens are credited. A purchase, an item use, and a
  settle all move `updated_at` and must leave it alone, or the panel reads a shopping trip as work.
- Everything is seeded from stored facts rather than a clock, so a retried roll is the same roll.
  `now` is passed in, never read. The one scheduler in the plugin — the push floor in `src/push.ts`
  — takes its `Schedule` as an argument for the same reason the host's coalescer does: a bare
  `setTimeout` would put "the last change of a burst is delivered" in a test name rather than in the
  code.
- `settle` is idempotent; calling it on read costs a comparison, not a second helping of growth.
- Species names are resolved server-side and **cache-only** — `cachedSpeciesName` takes `files` and
  not `net`, enforced by the type. A roster repainting on a poll must not become a crawl of an
  unpaid public API.
- A cold cache is an ordinary state, not an error: the panel shows `#25` and the name fills in later.

## Git and subagents

- Commit subjects are imperative and sentence case, describing intent rather than mechanics.
- Branch for work; do not commit to `main` directly. Do not use worktrees.
- An orchestrator creates an implementation subagent, then a separate review subagent. Subagents do
  not spawn nested subagents.
- A review subagent that reports "the tests pass" has not reviewed anything. Ask it enumerated
  questions and require `file:line` plus a quote of the code it judged.
