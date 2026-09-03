# Running the companion on a gateway that is several replicas

## Problem

OmniGateway grew a cluster mode
(`omnigateway/docs/superpowers/specs/2026-09-02-horizontal-scaling-design.md`): one
installation served by N stateless pods over one Postgres and one Redis. This plugin was
written against the single process that mode replaces, and every assumption it made about
being alone is now wrong in a different way.

Five failures, in the order an operator meets them:

1. **It does not load at all.** The host is at `PLUGIN_API_VERSION = 3` and the manifest
   declared `api: 2`; the loader refuses it by design. Generation 3 is `ctx.storage`
   becoming asynchronous, which is what lets a store other than SQLite serve plugin storage.
2. **Its SQL is SQLite-only.** `preparePluginSql` expands `{{name}}` and rewrites nothing
   else, so `?` placeholders reach Postgres verbatim and fail. `$1` binds on both.
3. **Every read-modify-write is a race.** `purchase` carried a comment arguing a transaction
   was decoration because "`bun:sqlite` is synchronous and this process single-threaded".
   Neither half survives: storage awaits, and there are N processes. Two replicas reading one
   save, both computing from it and both writing means an item bought and lost, a candy
   granted twice, or — worst — `consumedTotal` going backwards and a lifetime of tokens
   re-granted as growth, Dex row after Dex row for work already paid for.
4. **Dex ids were minted, not derived.** `${key}:${base}:${final}:${now}:${processCounter}`
   contains a per-process counter, so two replicas mint two ids for one graduation and file it
   twice — and a collision throws *after* the state was written, losing a graduation silently.
5. **The panel goes quiet.** A `connectionId` is meaningful only on the pod whose socket
   produced it. `PluginChannel.send` therefore reaches the panels that happen to share a
   replica with the code calling it, and a credit processed on any other pod reaches nobody —
   while the panel has switched its poll off precisely because the channel is live
   (`2026-08-31-live-companion-channel-design.md`). Live push made this worse than polling.

## Decisions

- **The plugin targets both modes with one code path.** There is no cluster branch, no mode
  flag, and nothing reads `/health`. Everything below is correct on one process and on
  twenty; a single-node install pays one extra `SELECT` per write and nothing else.
- **One dialect, not two.** `$n` placeholders and `ON CONFLICT` clauses both databases
  accept. Where the two dialects genuinely diverge, the plugin does not go.
- **Compare-and-swap, not locks.** No advisory lock exists on SQLite and none is reachable
  from `PluginStorage`. Every write is conditional on the save it was computed from.
- **The host gained `PluginChannel.broadcast`** rather than this plugin polling its own
  table for other replicas' writes. A store tail was designed and rejected: it puts a
  timer and a query loop in every pod to rediscover something the transport already knows,
  and every plugin with a panel would need its own copy.

## Compare-and-swap

`CompanionRow` gained `raw`, the save exactly as the column holds it, and `writeState` is
the only site that writes `state`:

```sql
UPDATE {{companion}} SET state = $1, updated_at = $2 WHERE api_key_id = $3 AND state = $4
```

The expected value is the stored *text*, never a re-serialisation of the parsed state:
`parseState` clamps, defaults and drops, so a save that round-trips to different bytes would
never match itself and no write would ever land.

`PluginStorage.run` reports no row count, so the statement reports itself: every conditional
write ends in `RETURNING`, and `storage.get` answers null when nothing matched.

**The obvious substitute — write, then read the row back and compare — was written first and
is wrong in the direction that costs the most.** It is two statements with an await between
them, so anybody who reads what we just wrote and writes their own save before our `SELECT`
lands turns a swap that *succeeded* into "failed". A settle that reports no write files no Dex
row for a graduation the row has already taken, and nothing re-emits it because the state has
moved; a purchase answers 409 with the wallet already debited. A false negative here is
unrecoverable where a false positive is merely rude, and inference cannot tell them apart.

With `RETURNING`, a second caller writing a byte-identical save correctly hears "no" and loses
nothing by it: the identical intent was already applied by the caller that won.

Purchases carry the wallet check into the same predicate
(`tokens_total - tokens_spent >= $price`), because the read above it is what refuses politely
and the predicate is what makes the refusal true.

**Losing is not retrying, with one exception.** A settle, a purchase, an item use and an
unpin all report the loss; the next poll reads the winner's save. The exception is the rare
candy grant, where the window has already been claimed and a window pays once: that write
retries against a re-read save three times before giving up with a log line, because
abandoning it drops a payout nothing can re-award.

## Graduations

`settle` now writes its own Dex rows, after the swap it won. They used to be the caller's,
one statement later — on one process merely two writes, on a fleet a window where the losing
replica records graduations from a state it did not write.

**Not in a transaction, and the first draft of this design was wrong about that.** The host's
SQLite plugin storage is one connection with `BEGIN`/`COMMIT` written by hand and no queue in
front of it, so two overlapping `storage.transaction` calls fail with "cannot start a
transaction within a transaction" — and two settles overlap the moment one of them awaits,
which is the ordinary path: a poll settling while a credit settles. The transaction bought a
crash window between two writes and cost every concurrent settle on the default backend. What
remains is the ordering, plus ids that make a repeat idempotent.

Ids are derived from stored facts: `${apiKeyId}:${digest(theSave)}:${index}`. A retried or
duplicated settle over the same save produces the same id, and the insert is
`ON CONFLICT (id) DO NOTHING`, so it is idempotent rather than merely unlikely to collide.

**The save, not its `consumedTotal`, and that correction cost a Pokédex entry to find.** That
number moves with traffic, and growth arrives without any: an everstone banks it, a rare candy
injects it, and a graduation hands its overflow to the next egg. Two graduations at one token
total therefore both took index 0 of the same number — an unpinned companion graduating, and
the line that hatched from its overflow graduating on the next settle, produced one id between
them and `DO NOTHING` swallowed the second.

Sightings stay outside the transaction and stay the caller's, because they are written on
*every* settle including the ones that change nothing — that is what registers a companion
already half way up its line, and it is idempotent on its own primary key.

## The grant window

`setGrantedAt` was an unconditional upsert, which on a fleet lets both replicas that saw one
`LimitReached` pay. It is replaced by `claimGrant(previous, at)`: a conditional upsert on the
instant the caller read, with the outcome read back. Exactly one replica wins the window and
only the winner writes candy.

It ends in `RETURNING` for the same reason every other conditional write does, and here the
read-back version was not merely fragile but wrong: two replicas writing the same instant would
each find *their own* number on the row, put there by the other, and both pay. Nor did that
need two clocks — two limit events for one key drain in a single pass of the host's bus and
both read the same `now`, so one process reached it alone.

## The channel

The host now offers `PluginChannel.broadcast(payload)`, which names the topic rather than a
connection and fans out over `coord.pubsub` to every replica's subscribers — the same path
`res:*` already takes. It is uncoalesced there, because a plugin's payload identifies *which*
key changed and folding by topic would drop every frame but the last; the per-key floor in
`src/push.ts` remains this plugin's own responsibility and is unchanged.

It arrived in `@omnigateway/plugin-api@0.4.0` **without a generation bump**, so a manifest
cannot ask for it. The plugin feature-detects and degrades to `send`, which is the posture
every capability here already takes.

One property is deliberately given up. `push` used to return early when this process held no
listeners — "no audience, no work". A replica's own listener set says nothing about the
fleet's, and suppressing on it is exactly what made the panel go quiet, so with a broadcast
available the frame goes out regardless. What bounds the cost is the per-key floor and the
fact that frames follow writes: an idle key still costs nothing.

## What is deliberately not solved

- **The species cache is per pod.** `files` is a pod-local directory with no shared volume,
  so each replica builds its own copy of the ~649-request species index once. It is a cache
  of immutable third-party facts, the in-flight latch already stops one pod stampeding, and
  a cold cache is an ordinary state the panel renders as `#25`.
- **The name, warm and backoff maps are per pod.** Same reasoning: caches of immutable facts,
  self-healing, and bounded per poll.
- **Plugin tables do not migrate between dialects.** The host's own `omni db migrate --to`
  does not carry `plugin_*`, so moving an installation to Postgres starts every companion
  again. That is the host's decision and this plugin cannot improve on it; it is recorded
  here so nobody discovers it during a migration.

## Column widths

Every instant and every accumulating counter is `BIGINT`, not `INTEGER`. SQLite's `INTEGER` is
64-bit whatever a column declares, so on the default backend the word is advisory; Postgres
reads it as `int4` and stops at 2 147 483 647, while an epoch millisecond is 1.7e12. The first
credit on a clustered install would have failed with "value out of range", inside an event
handler, where it surfaces as one warning line — the plugin would migrate, load, and never
write a row. A shiny charm costs 3e9, so the counters overflow on their own account as well.

The migrations were edited in place rather than extended, because there is no portable
`ALTER`: SQLite cannot change a column's type. That is safe for the same reason it is
necessary — a SQLite install applied version 1 long ago, never re-reads the text, and stores
the same bytes either way, while a Postgres install is necessarily fresh.

At the read end `BIGINT` arrives from Bun's driver as a **string**. Every mapper converts, as
the host's own repos do; without it `tokens_total - tokens_spent` is a subtraction between
strings and a wallet renders as `NaN`.

## History

- The transactional settle above was written, and `test/fleet.test.ts` — which drives two
  settles at once, because that is what a second replica is — failed on it immediately with
  SQLite's nested-`BEGIN` error. The bug was not in the fleet: it was on every single-node
  install, on the path a panel takes. A design that had shipped without a concurrent test
  would have made the default backend worse in the name of making the clustered one better.
- The rule that two byte-identical writers both hear "yes" was likewise discovered by a test
  written to assert the opposite, defended in this document, and then deleted along with the
  read-back that made it necessary. It was a true statement about a mechanism that should not
  have existed: the same inference that produced the harmless false positive produced the
  harmful false negative, and `RETURNING` produces neither.
- `purchase` kept the read-back for a commit longer than everything else did, because the edit
  that was supposed to replace it was written against a line the formatter had already
  rewrapped: it did not apply, the failure was swallowed by a later error in the same batch,
  and every test still passed — the inference is only wrong when somebody writes in between.
  It survived on the one path where being wrong costs a wallet. Found by re-checking each
  finding against the code rather than against the memory of having fixed it.
- The SQL was driven once through the host's **real** `PluginRepo` rather than the mirror in
  `test/helpers/storage.ts` — migrations 1 to 7 through the actual guard, `RETURNING` on the
  `UPDATE` and on both conflict clauses, and a counter and an instant past `int4` round-tripped.
  It cannot be kept as a test in either repository: the host may not depend on a plugin, and a
  plugin cannot import the unpublished `@omni/store`. That gap is why the mirror exists and why
  it has to be re-run by hand when either side moves.
- Three of the findings above — the column widths, the false negative, and the Dex id — were
  found by review with runnable probes rather than by any suite here, because all three are
  invisible on SQLite or need two writers. Two are now pinned by `test/fleet.test.ts` (a
  storage that stringifies its numbers the way the Postgres driver does; a graduation pair at
  one token total) and one by a source-text check for `?` placeholders.

## Amends

- `2026-08-19-pokemon-companion-plugin-design.md`: storage is asynchronous; `purchase` is
  conditional rather than unguarded, and the note arguing a transaction would be decoration
  is superseded by the paragraph in `src/store.ts`.
- `2026-08-31-live-companion-channel-design.md`: a frame is broadcast to the fleet rather
  than sent per connection, and "no audience, no work" holds only where no broadcast exists.
