# The Panel Stops Guessing

## Problem

The panel could not hear anything. Growth arrives from requests it has no way to
observe, so it polled every ten seconds and `ui/index.tsx` said as much:

> Growth arrives from requests this panel has no way to hear about, so without a
> poll an operator watching a companion evolve is watching a screenshot.

Ten seconds is a poor number in both directions at once. It is far too slow for
the moment that matters — an egg hatches and the operator learns about it up to
ten seconds later, having watched an egg the whole time — and far too fast for
the moments that do not, since most polls of a companion nobody is spending
against re-read a save, rebuild a Dex and resolve a name to render the same
screen again.

Plugin API generation 2 removes the reason. `ctx.channels` opens a named topic on
the gateway's push socket, and `@omnigateway/dashboard-sdk` 0.1.4 gives the panel
`usePluginChannel` to hold one. This design adopts both.

**Amended 2026-09-03.** A frame is `broadcast` rather than `send`, where the host
offers it (`@omnigateway/plugin-api` 0.4.0). A `connectionId` is meaningful only
on the replica whose socket produced it, so on a clustered gateway `send` reached
the panels that happened to share a pod with the code calling it — and the poll
this design switches off was the only thing that had been covering the gap. With
it goes "no audience, no work": this process's listener set says nothing about the
fleet's, so a frame goes out whether or not anyone is connected *here*. The floor
below is unchanged and is what bounds the cost. See
`2026-09-03-multi-pod-deployment-design.md`.

## What this is not

It is not a second copy of companion state on the wire. A frame carries
`{ apiKeyId }` and nothing more — a claim that something changed, never what it
changed to. The console's own transport made this rule first, in
`apps/dashboard/src/session/invalidation.ts`:

> No `res:*` frame renders a payload, which is what keeps push and poll from
> ever disagreeing on those topics — both paths end in the same fetch and the
> same serializer.

The argument is stronger here than it is there. `GET /keys/:id` settles growth,
rebuilds the collection from stored graduations, resolves a display name from
the species cache, and may start a hatch prefetch. A frame carrying companion
state would either duplicate all of that inside an event handler or ship a
thinner view that contradicts the polled one — and the polled one does not go
away, because it is the fallback.

## The invariant

**A frame is emitted on every write to `{{companion}}`, and on no read.**

Both halves are load-bearing. The first is what makes it safe to stop polling:
if some write could change the panel's answer without emitting, an operator
would sit in front of a stale screen with nothing scheduled to correct it. The
write sites, all seven — eight statements, since `settle` is reached from four
call sites and writes through one of them:

| Write | Site | What the panel would otherwise miss |
| --- | --- | --- |
| `creditTokens` | `onRequestCompleted` | Tokens and the wallet — and the row's lazy creation, which is a key joining the roster |
| `settleAndRecord` | `onRequestCompleted`, and on read | A hatch, an evolution, a graduation and its Dex row |
| candy grant | `onLimitReached` | Inventory |
| `pendingHatch` | the unawaited hatch prefetch | The roll behind the next hatch |
| `pendingReveal` | the unawaited reveal prefetch | The line behind a Ditto's reveal |
| purchase | `POST /keys/:id/purchase` | A second tab's view of the wallet |
| item use / unpin | `POST /keys/:id/use`, `/unpin` | A second tab's view of the bag |

The two prefetch writes are the ones that would be missed by anyone enumerating
the obvious sites, and one of them **was** missed on this design's first pass —
the table above originally listed only `pendingHatch`. Both are fired unawaited
by `prefetchOnce` from the panel's own route and land long after that response
went out, which on a cold species cache is minutes and roughly 649 fetches. With
polling on, the next poll collects them. With polling off and no frame, the egg
never opens and the Ditto never reveals — a companion waiting on a write that
has already happened, forever.

Recorded rather than quietly corrected because the shape of the mistake is the
useful part: both are writes that no request and no route return value is
attached to, so an enumeration that walks the handlers finds neither.

The mutation routes are the three where a frame is arguably redundant: the panel
that made the request already invalidates its own queries on success. They emit
anyway, because a second console tab is not a hypothetical and a money surface
showing a wallet that was spent two minutes ago is the failure this plugin is
least allowed to have. The cost is one extra refetch in the tab that acted.

### Why not on a read

`GET /keys/:id` settles on the way in, so "emit whenever this route runs" would
have the panel refetch, settle, emit and refetch again. It terminates — `settle`
is idempotent and writes nothing the second time, so the second round is silent
— but it doubles the traffic of every read for nothing. Emitting from the write
rather than from the route is both the cheaper rule and the one that is true.

## Coalescing

A frame per credit is a refetch per request. At any real request rate that is
worse than the poll it replaces, and the host wrote the argument down first, in
`apps/gateway/src/stream/coalescer.ts`:

> At 100 requests per second a per-request `res:usage` frame is 100 client
> refetches per second, against a surface that polls at 60s today. Uncoalesced
> push is strictly slower than the poll, and it is the easiest way for this
> transport to make the product worse.

`src/push.ts` mirrors the host's answer: **leading and trailing, never one or the
other.** The first emit for a key goes out immediately; further emits inside the
floor are dropped and leave the armed timer alone; the trailing frame fires at
the floor. The host stores the newest payload per topic at that point and this
does not, because every frame about a key is `{ apiKeyId }` — there is nothing
to replace. Leading alone loses the last change of a burst, which
is the one the operator is watching for. Trailing alone puts a floor's worth of
latency on an idle gateway's first event, which is the case a socket was added
for. Re-arming the timer on every emit would be a debounce, and a debounce under
sustained load never fires at all.

The floor is **1000 ms**, keyed per API key. It is the figure
`INVALIDATION_FLOORS` gives `res:usage` and `res:logs` — which replace a 60s poll
and a 2s one respectively, so it is the host's judgement about its hottest
topics rather than a ratio anybody derived. One of those polls is faster than
this panel's ten seconds, which is the part that makes it comfortable here.
Per key rather than per channel, because two keys earning at once are two
independent stories and flooring them together would let a busy key starve a
quiet one's frame.

**This is a mirror, not a share.** `apps/gateway/src/stream/coalescer.ts` is
internal to the gateway and unpublished, the same situation `test/helpers/storage.ts`
is in with `@omni/store`. When the host's floors move, this file does not hear
about it.

### No audience, no work

If no connection has announced itself, `push` returns before it records anything
or arms anything. An install with the panel closed — nearly all of them, nearly
all the time — pays exactly what it paid before this design.

It also disposes of a problem the API leaves open. `PluginSetupResult` is
`{ routes }` and nothing else, so a plugin has no teardown hook and nothing to
call a `stop()` from. Timers that only exist while a panel is watching cannot
outlive an audience by more than one floor.

## Connections

The server half has no broadcast. `PluginChannel` is `onMessage`,
`send(connectionId, payload)` and `onClose` — a plugin may only send to a
connection it has already heard from, which is the other side of the host's rule
that a client must subscribe before it sends:

> a frame from an unsubscribed connection is a question whose answer has nowhere
> to land — the host refuses it rather than handing you one you cannot reply to.

So the panel announces itself. On `status === "open"` it sends one hello; the
plugin records the `connectionId`; `onClose` removes it. The set is in memory and
is meant to be: a `connectionId` is opaque, means nothing after `onClose` names
it, and is not an identity — two tabs belonging to one operator share nothing.
Nothing here goes in a table, because nothing here survives a restart and
nothing should pretend to.

## The panel

```tsx
const channel = usePluginChannel(pluginId, "activity", onFrame);
const roster = useQuery({ …, refetchInterval: cadence(REFETCH_MS, channel.topic) });
```

`cadence(ms, topic)` is `false` while the topic is being pushed and `ms` when it
is not, so the poll switches itself off when the channel is live and back on
when the socket drops. That is the console's own fallback shape rather than a
new one, and it is why the poll is kept rather than deleted: the fallback has to
exist for the channel to be allowed to fail.

`onFrame` narrows `unknown` before it acts. A frame names a key; the roster is
always invalidated, and the open companion only when the key is the one on
screen.

No status indicator. `refused` is unreachable for this panel — `authorised`
grants an admin principal every opened plugin topic — and the console is already
the place that reports whether it is pushing or polling.

## What this deliberately does not protect against

A dropped **socket** is covered: `pushed(topic)` goes false, and the ten-second
poll comes back on its own.

A dropped **frame** on a live socket is not. Channel delivery is best-effort and
bounded — a subscriber that cannot keep up loses its oldest frames — so a lost
frame costs staleness on that key until its next write. The host accepts the
same exposure on `res:usage` and it is inherited here knowingly. The floor does
not remove it and no part of this design claims otherwise.

## Amendments to earlier specs

`2026-08-19-pokemon-companion-plugin-design.md` records the panel as a polling
surface and calls the ten-second interval the whole of its freshness story. That
is now the fallback rather than the mechanism. The interval itself is unchanged
and still governs every case where the channel is absent: no `channels`
capability, a console below SDK 0.1.4, a socket that never opened, or a proxy
that strips `Upgrade`.

The same spec records the plugin as declaring five capabilities. It declares six;
`channels` is the sixth, and like the others its absence is degradation rather
than failure — no channel, no frames, and the poll carries the panel exactly as
it did at 1.2.2.
