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
 * in the gateway. Those were chosen against a 60-second poll and this replaces a
 * ten-second one, so the ratio here is the more conservative of the two.
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

  const send = (apiKeyId: string): void => {
    lastSent.set(apiKeyId, deps.now());
    for (const connectionId of listeners) deps.send(connectionId, { apiKeyId });
  };

  const fire = (apiKeyId: string): void => {
    if (!pending.delete(apiKeyId)) return;
    send(apiKeyId);
  };

  return {
    join(connectionId) {
      listeners.add(connectionId);
    },

    leave(connectionId) {
      listeners.delete(connectionId);
      if (listeners.size > 0) return;
      // Nobody left to receive it. A plugin gets no teardown hook — a
      // `PluginSetupResult` is `{ routes }` — so this is the only moment a
      // pending timer can be cleaned up, and without it the "no audience, no
      // work" property would be true only of pushes and not of timers.
      for (const cancel of pending.values()) cancel();
      pending.clear();
    },

    push(apiKeyId) {
      // Before anything is recorded, so an install whose panel is closed pays
      // nothing at all: no map entry, no timer, no frame.
      if (listeners.size === 0) return;

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
