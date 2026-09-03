/**
 * Who is watching a companion, and how often they may be told it changed.
 *
 * The panel used to poll every ten seconds because it had no way to hear about
 * a request. Generation 2 of the plugin API gives it one, and this module is the
 * part that keeps the cure from being worse than the disease.
 *
 * ## Why a floor exists at all
 *
 * A frame per credited request is a panel refetch per credited request, against
 * a route that settles growth, rebuilds a Dex and resolves a name. The gateway's
 * own `stream/coalescer.ts` states the failure plainly — a per-request frame at
 * 100 requests per second is 100 refetches per second against a surface that
 * polled at 60 — and reaches the answer this file mirrors: **leading and
 * trailing, never one or the other.** Leading alone drops the last change of a
 * burst, which is the one an operator is watching for. Trailing alone puts a
 * floor's worth of latency on an idle gateway's first event, which is the case
 * the socket was added for.
 *
 * ## A mirror, not a share
 *
 * `apps/gateway/src/stream/coalescer.ts` is internal to the gateway and
 * unpublished, so this cannot import it — the same position `test/helpers/storage.ts`
 * is in with `@omni/store`, and with the same consequence: when the host's floors
 * move, nothing here finds out. It is simpler than the original in one way that
 * is worth naming rather than mistaking for an omission. The host stores the
 * newest payload per topic because its payloads differ; every frame this plugin
 * sends about a key is `{ apiKeyId }`, so there is nothing to replace and a
 * pending entry needs only its cancel.
 */

/** Reads the current instant. Injected, like every clock in this plugin. */
export type Clock = () => number;

/**
 * How a trailing frame is deferred, and how a deferred one is cancelled.
 *
 * Injected for the reason the host injects its own: a timer is invisible to
 * assertions, so with a bare `setTimeout` "the last change of a burst is
 * delivered" would live in a test name rather than in the code.
 */
export type Schedule = (run: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The shortest interval between two frames about one key.
 *
 * A second, which is what `INVALIDATION_FLOORS` gives `res:usage` and `res:logs`
 * in the gateway. Those two share a figure while replacing very different polls
 * — 60 seconds for usage and 2 for logs — so the number is not a ratio anybody
 * derived, and copying it as though it were would be inventing a rule. What it
 * is: the floor the host settled on for its hottest topics, one of which
 * (`res:logs`) it applies to a *faster* poll than this panel's ten seconds. If
 * that is tolerable there it is comfortable here.
 *
 * Per key rather than per channel: two keys earning at once are two independent
 * stories, and a shared floor would let a busy key swallow a quiet one's only
 * frame.
 */
export const PUSH_FLOOR_MS = 1_000;

/** What a frame says. Never what the companion now is — see the design. */
export type ActivityFrame = { apiKeyId: string };

export type Pusher = {
  /** Records a connection that has announced itself on the channel. */
  join(connectionId: string): void;
  /** Forgets a connection the host has reported as gone. */
  leave(connectionId: string): void;
  /** Reports that `apiKeyId` was written, subject to the floor. */
  push(apiKeyId: string): void;
};

export type PusherDeps = {
  send: (connectionId: string, payload: ActivityFrame) => void;
  /**
   * Delivers to every connection holding this channel, on every replica.
   *
   * `PluginChannel.broadcast`, which arrived in `@omnigateway/plugin-api` 0.4.0
   * without a generation bump — so it is optional here for the same reason every
   * capability is: an older gateway does not have it, and the plugin degrades
   * rather than throws. Degradation is `send` to this process's own listeners,
   * which is exactly what shipped before, correct on one process and blind on a
   * fleet.
   */
  broadcast?: (payload: ActivityFrame) => void;
  now: Clock;
  floorMs?: number;
  schedule?: Schedule;
};

export function createPusher(deps: PusherDeps): Pusher {
  const floorMs = deps.floorMs ?? PUSH_FLOOR_MS;
  const schedule = deps.schedule ?? defaultSchedule;

  /**
   * Connections that have said hello.
   *
   * A `Set`, so the panel's hello arriving twice on one connection — which it
   * will, since the panel re-announces whenever the channel reopens — leaves one
   * recipient rather than two copies of every frame.
   *
   * In memory and never in a table. A `connectionId` is opaque, means nothing
   * once `onClose` has named it, and is not an identity; there is nothing here
   * that should survive a restart.
   */
  const listeners = new Set<string>();

  /** When each key last had a frame sent, so the floor is measured, not assumed. */
  const lastSent = new Map<string, number>();
  /** Keys with a trailing frame already armed, and how to call it off. */
  const pending = new Map<string, () => void>();

  const broadcast = deps.broadcast;

  const send = (apiKeyId: string): void => {
    lastSent.set(apiKeyId, deps.now());
    if (broadcast !== undefined) {
      broadcast({ apiKeyId });
      return;
    }
    for (const connectionId of listeners) deps.send(connectionId, { apiKeyId });
  };

  const fire = (apiKeyId: string): void => {
    if (!pending.delete(apiKeyId)) return;
    try {
      send(apiKeyId);
    } catch {
      // The one frame nobody else is holding. A leading frame is raised inside a
      // route handler or inside the event path's own guard, both of which catch;
      // this one is raised by a timer, where a throw out of the host's transport
      // is an uncaught exception with the gateway's process behind it. Swallowed
      // rather than logged, because the panel's own poll is the recovery and a
      // logger is not something this module has.
    }
  };

  return {
    join(connectionId) {
      listeners.add(connectionId);
    },

    leave(connectionId) {
      listeners.delete(connectionId);
      if (listeners.size > 0) return;
      // A broadcast reaches an audience this process cannot see, so an empty
      // local listener set is not an empty audience and nothing pending may be
      // cancelled on the strength of it. Every pending entry fires within one
      // floor, so nothing accumulates there.
      //
      // `lastSent` is what this early return does keep, and keeping it is the
      // point: with frames still going out, forgetting when a key last had one
      // would let the next write lead again inside its own floor. It holds a
      // string and a number per key ever written, which is bounded by the number
      // of API keys an installation has — the same order as the species names
      // this plugin already keeps for the life of the process.
      if (broadcast !== undefined) return;
      // Nobody left to receive it. A plugin gets no teardown hook — a
      // `PluginSetupResult` is `{ routes }` — so this is the only moment a
      // pending timer can be cleaned up, and without it the "no audience, no
      // work" property would be true only of pushes and not of timers.
      for (const cancel of pending.values()) cancel();
      pending.clear();
      // Cleared alongside it, as the host's `stop()` does. Two reasons: this map
      // otherwise keeps one entry per key ever pushed for the life of the
      // process, and a panel that closes and reopens inside a floor would have
      // its first change deferred by a trailing timer rather than led — measured
      // against an audience that no longer existed.
      lastSent.clear();
    },

    push(apiKeyId) {
      /*
        Before anything is recorded, so an install whose panel is closed pays
        nothing at all: no map entry, no timer, no frame.

        **Only while frames cannot leave this process.** A replica's own listener
        set says nothing about the fleet's: the panel is connected to whichever
        pod the balancer picked, and the write that matters happened wherever the
        request landed. Suppressing here is what made a cluster's panel go quiet,
        so with a broadcast available the frame goes out regardless of who is
        holding this process's sockets. What bounds it is the floor below and the
        fact that this is called on writes only — an idle key costs nothing
        either way.
      */
      if (broadcast === undefined && listeners.size === 0) return;

      // Inside the floor with a trailing frame already armed. Nothing to update
      // — every frame about this key is identical — and the timer is
      // deliberately left alone: re-arming it on each push is a debounce, and a
      // debounce under sustained load never fires.
      if (pending.has(apiKeyId)) return;

      const previous = lastSent.get(apiKeyId);
      const elapsed = previous === undefined ? Number.POSITIVE_INFINITY : deps.now() - previous;
      if (elapsed >= floorMs) {
        send(apiKeyId);
        return;
      }

      pending.set(
        apiKeyId,
        schedule(() => fire(apiKeyId), floorMs - elapsed),
      );
    },
  };
}
