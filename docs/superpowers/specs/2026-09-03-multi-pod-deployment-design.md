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

`PluginStorage.run` reports no row count, so the outcome is read back. That read is the
price of the guarantee.

**Two callers writing byte-identical saves both hear "yes", and that is correct rather than
tolerated.** Identical bytes mean identical `expected` and therefore identical intent — one
action submitted twice, not two actions. Exactly one `UPDATE` matched, so a purchase debits
once and an item is added once; telling the second caller it failed would report a loss that
did not happen. Two genuinely different intents cannot collide this way, because the second
reads the first's result as its own `expected`.

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

Ids are derived from stored facts: `${apiKeyId}:${consumedTotalBeforeTheSettle}:${index}`.
A retried or duplicated settle over the same save produces the same id, and the insert is
`ON CONFLICT (id) DO NOTHING`, so it is idempotent rather than merely unlikely to collide.

Sightings stay outside the transaction and stay the caller's, because they are written on
*every* settle including the ones that change nothing — that is what registers a companion
already half way up its line, and it is idempotent on its own primary key.

## The grant window

`setGrantedAt` was an unconditional upsert, which on a fleet lets both replicas that saw one
`LimitReached` pay. It is replaced by `claimGrant(previous, at)`: a conditional upsert on the
instant the caller read, with the outcome read back. Exactly one replica wins the window and
only the winner writes candy.

Known bound, marked in the source: two replicas claiming a *fresh* window in the same
millisecond both read back their own instant and both pay. One extra candy, rate-limited by
the window's own duration. Closing it needs a claim-token column.

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

## History

- The transactional settle above was written, and `test/fleet.test.ts` — which drives two
  settles at once, because that is what a second replica is — failed on it immediately with
  SQLite's nested-`BEGIN` error. The bug was not in the fleet: it was on every single-node
  install, on the path a panel takes. A design that had shipped without a concurrent test
  would have made the default backend worse in the name of making the clustered one better.
- The rule that two byte-identical writers both hear "yes" was likewise discovered by a test
  written to assert the opposite. Two consumes of one held item produce the same save, so
  telling the second one `stale` would report a loss that did not happen — the assertion was
  wrong, not the code.

## Amends

- `2026-08-19-pokemon-companion-plugin-design.md`: storage is asynchronous; `purchase` is
  conditional rather than unguarded, and the note arguing a transaction would be decoration
  is superseded by the paragraph in `src/store.ts`.
- `2026-08-31-live-companion-channel-design.md`: a frame is broadcast to the fleet rather
  than sent per connection, and "no audience, no work" holds only where no broadcast exists.
