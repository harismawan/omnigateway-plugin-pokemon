# omnigateway-plugin-pokemon

A Pokémon companion for [OmniGateway](https://github.com/harismawan/omnigateway).

Each gateway API key raises one companion. It hatches, evolves, and graduates
into a per-key Pokédex on the tokens that key spends, with a shop that spends a
wallet of those same tokens. It is strictly an observer: nothing it stores
affects routing, limits, or anything a request depends on.

## Name

Unscoped, on purpose. `@omnigateway/*` is the project's own scope, and a
third-party plugin could never publish into it — so this repository is named the
way an external author's would be, `omnigateway-plugin-<name>`, the same
convention as `eslint-plugin-*`. It is the companion plugin, not a first-party
one, and the packaging should say so.

## Install

The gateway resolves a plugin by name through npm, so the host needs no checkout
and no build toolchain:

```bash
omni plugin install omnigateway-plugin-pokemon
omni plugin verify pokemon && omni restart
```

`verify` is the one to run before restarting a gateway that people are using: it
reaches the same verdict the next boot will, from the same code, without loading
the plugin.

Resolving a name through npm makes distribution easier; it does not make an
unknown plugin safer. Integrity checking proves you received the bytes the
registry advertised, and nothing about who wrote them or what they do once the
gateway imports them.

### From a checkout

```bash
bun install
bun run build                 # writes dist/pokemon
omni plugin install ./dist/pokemon
omni restart
```

The built directory is `dist/pokemon` and the name matters: the installer takes
the installed directory name from the source and refuses a manifest whose `id`
disagrees with it, so a plugin cannot be installed under a name that is not its
own.

## Capabilities

The manifest declares five, and each one is there for a reason a reader can
check:

| Capability | Why |
| --- | --- |
| `storage` | Three tables on the plugin's own migration track, named `plugin_pokemon_<name>` by the host: the companion row per key, the Dex, and the grant ledger. |
| `files` | The species index and cached sprites live in the plugin's scoped data directory, **not** in a table. That directory is excluded from database snapshots, exactly as `request_bodies/` is — the alternative would put tens of megabytes of artwork into every snapshot an operator downloads, and it re-fetches itself anyway. |
| `net:outbound` | Species data and sprites are fetched at runtime. The manifest also declares the origins, `https://pokeapi.co` and `https://raw.githubusercontent.com`; the host hands the plugin a `fetch` bound to that allowlist and refuses anything else. |
| `events:request` | Growth is credited from `RequestCompleted` — all four token classes, which are disjoint, so summing them double-counts nothing. |
| `events:limit` | A key parked at a `5h` or `1w` ceiling earns a rare candy, rated by the window's own length. A `1m` ceiling pays nothing: a minute is not a span in which work happened. |

Worth restating, because a plugin author reading a capability list will assume
otherwise: **this is a guardrail, not a sandbox.** A plugin shares the gateway's
process and can import past all of it. What the declaration buys is that
accidental overreach is impossible and that the plugin's intent is auditable
from one readable file. It constrains honest code and not hostile code.

The plugin degrades rather than failing when a capability is absent. With no
`net`, an incubating egg holds its progress instead of losing it, and the sprite
route answers `503`.

## Nintendo and Game Freak intellectual property

The sprites, names, and evolution data are Nintendo and Game Freak intellectual
property, fetched at runtime from PokéAPI and the community sprite repository.
**Nothing is vendored** — not into this repository, not into the published npm
package, not into any built artifact. A running install contacts `pokeapi.co`
and `raw.githubusercontent.com` and caches what it gets in its own scoped data
directory.

This plugin ships separately, as something an operator chooses to fetch, rather
than inside OmniGateway's npm package or Docker image. Infrastructure other
people deploy is a different exposure profile from a personal application, and
that packaging decision follows from it. Recorded here so it stays a knowing
one.

## Development

```bash
bun install
bun run test      # the plugin's own suites
bun run test:ui   # the console panel, under happy-dom, separately
bun run typecheck
bun run lint
bun run build
```

The UI suite runs on its own because registering a DOM mutates process-wide
globals, which would leak into every other file sharing the process.

This package builds against the published `@omnigateway/plugin-api` and
`@omnigateway/dashboard-sdk` and against nothing internal to the gateway. That
is deliberate: a plugin developed inside the monorepo can reach packages an
installed plugin cannot, and a build that only succeeds there proves nothing
about one that has to run anywhere else.

## Licence

MIT. See [LICENSE](LICENSE). The licence covers this plugin's code and not the
third-party assets it fetches at runtime.
