# Pokémon Companion Plugin — Repository Guidance

Agent guidance for repository work: boundaries, conventions, and durable traps. `README.md` serves
operators and plugin authors; `DESIGN.md` records the design and every amendment to it; this file
serves contributors. Update all that a change affects — `DESIGN.md` in particular, because an
amendment nobody wrote down becomes a rule nobody can check.

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
   rather than throw: no `net` means an egg holds its progress and the sprite route answers 503.
4. The manifest is a guardrail, not a sandbox. A plugin shares the gateway's process and can import
   past all of it. What the declaration buys is that accidental overreach is impossible and that
   intent is auditable from one readable file.
5. The panel talks to its own backend through the SDK's `api`, which is bound to
   `/api/plugins/pokemon/`. It does not reach the console's own API, and a path that tries is
   refused rather than normalised.
6. Nintendo and Game Freak assets are **never vendored** — not into the repository, the npm package,
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
- `test/helpers/storage.ts` mirrors the host's storage rules; it does not share them. `@omni/store`
  is unpublished, so an external plugin cannot test against the code that will run its SQL. When the
  host's rules change, that mirror must change with them or migrations pass here and fail at boot.
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
- `last_credit_at` is written **only** where tokens are credited. A purchase, an item use, and a
  settle all move `updated_at` and must leave it alone, or the panel reads a shopping trip as work.
- Everything is seeded from stored facts rather than a clock, so a retried roll is the same roll.
  `now` is passed in, never read.
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
