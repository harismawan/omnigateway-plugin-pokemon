import { expect, test } from "bun:test";
import { createPusher, PUSH_FLOOR_MS, type Schedule } from "../src/push.ts";

const NOW = 1_700_000_000_000;

/**
 * A clock and a scheduler that only move when a test says so.
 *
 * The point of injecting `Schedule` at all: with a real `setTimeout` every
 * assertion about the trailing frame would be a sleep, and "the last change of a
 * burst is delivered" would be a claim in a test name rather than in the code.
 */
function harness(floorMs = PUSH_FLOOR_MS, broadcasting = false) {
  let now = NOW;
  const sent: Array<{ connectionId: string; payload: unknown }> = [];
  /**
   * Armed timers, newest last.
   *
   * `dueAt` is recorded at arm time rather than the delay being compared against
   * the size of one `advance` call. Two timers armed at different instants are
   * otherwise indistinguishable — one armed at `t=100` for 1000 ms is due at
   * 1100, and a helper that fired everything with `ms <= 1000` would run it at
   * `t=1000`, a hundred milliseconds early and green.
   *
   * `fired` and `cancelled` are separate because they mean opposite things. One
   * flag for both would make "the pending frame was called off" true of a timer
   * that ran, which is the assertion it exists to make.
   */
  const timers: Array<{
    ms: number;
    dueAt: number;
    run: () => void;
    cancelled: boolean;
    fired: boolean;
  }> = [];

  const schedule: Schedule = (run, ms) => {
    const timer = { ms, dueAt: now + ms, run, cancelled: false, fired: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  /** Frames the host would fan out to every replica, when it can. */
  const fanned: Array<{ apiKeyId: string }> = [];

  const pusher = createPusher({
    send: (connectionId, payload) => sent.push({ connectionId, payload }),
    ...(broadcasting ? { broadcast: (payload: { apiKeyId: string }) => fanned.push(payload) } : {}),
    now: () => now,
    floorMs,
    schedule,
  });

  return {
    pusher,
    sent,
    fanned,
    timers,
    /** Moves the clock and fires every armed timer that has genuinely come due. */
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.fired || timer.dueAt > now) continue;
        timer.fired = true;
        timer.run();
      }
    },
    keys: () => sent.map((frame) => (frame.payload as { apiKeyId: string }).apiKeyId),
  };
}

test("a change reaches every announced connection at once", () => {
  // Leading edge. An idle gateway's first event is the case a socket was added
  // for, and making it wait out a floor would be the transport arriving slower
  // than the poll it replaces.
  const h = harness();
  h.pusher.join("c1");
  h.pusher.join("c2");

  h.pusher.push("key-a");

  expect(h.sent).toEqual([
    { connectionId: "c1", payload: { apiKeyId: "key-a" } },
    { connectionId: "c2", payload: { apiKeyId: "key-a" } },
  ]);
});

test("a burst inside the floor is one frame now and one when the floor expires", () => {
  // Leading *and* trailing. Leading alone loses the last change of a burst,
  // which is the one the operator is watching for — the request that finished a
  // hatch is the one that matters, not the one that started the burst.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  h.pusher.push("key-a");
  h.pusher.push("key-a");
  expect(h.keys()).toEqual(["key-a"]);

  h.advance(PUSH_FLOOR_MS);

  expect(h.keys()).toEqual(["key-a", "key-a"]);
});

test("a sustained burst still delivers, because the timer is never re-armed", () => {
  // The debounce trap, and the reason this is a floor rather than a wait. Were
  // the pending timer re-armed on every push, a key earning steadily would push
  // its own trailing frame forward forever and the panel would update only once
  // traffic stopped — the exact opposite of the intent.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  // Every one of these lands inside the floor.
  for (let i = 0; i < 50; i += 1) h.pusher.push("key-a");

  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
  expect(h.timers[0]?.ms).toBe(PUSH_FLOOR_MS);

  h.advance(PUSH_FLOOR_MS);
  expect(h.keys()).toEqual(["key-a", "key-a"]);
});

test("a key armed part way through a floor fires when it is actually due", () => {
  // Two keys whose floors start at different instants, which is the ordinary
  // case on a gateway serving more than one key and the one a harness comparing
  // a delay against a single advance cannot tell apart.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  h.advance(PUSH_FLOOR_MS / 2);
  // Inside a's floor, so this arms a trailing frame due half a floor from now.
  h.pusher.push("key-a");
  // b has never been pushed, so it leads immediately.
  h.pusher.push("key-b");

  expect(h.keys()).toEqual(["key-a", "key-b"]);

  h.advance(PUSH_FLOOR_MS / 2);
  expect(h.keys()).toEqual(["key-a", "key-b", "key-a"]);
});

test("two keys are floored independently", () => {
  // Per key rather than per channel. Two keys earning at once are two stories,
  // and a shared floor would let a busy key swallow a quiet one's only frame.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  h.pusher.push("key-b");

  expect(h.keys()).toEqual(["key-a", "key-b"]);
});

test("nothing is sent and nothing is scheduled while nobody is listening", () => {
  // The property that keeps this free for the installs that never open the
  // panel, which is nearly all of them nearly all of the time.
  const h = harness();

  h.pusher.push("key-a");
  h.pusher.push("key-a");

  expect(h.sent).toEqual([]);
  expect(h.timers).toEqual([]);
});

test("a departed connection is not sent to", () => {
  const h = harness();
  h.pusher.join("c1");
  h.pusher.join("c2");
  h.pusher.leave("c1");

  h.pusher.push("key-a");

  expect(h.sent).toEqual([{ connectionId: "c2", payload: { apiKeyId: "key-a" } }]);
});

test("the last connection leaving cancels the trailing frame it would have got", () => {
  // A plugin has no teardown hook — `PluginSetupResult` is `{ routes }` — so the
  // only moment a pending timer can be cleaned up is when its audience goes.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  h.pusher.push("key-a");
  h.pusher.leave("c1");

  h.advance(PUSH_FLOOR_MS);

  // The leading frame it was there for, and nothing after it left.
  expect(h.keys()).toEqual(["key-a"]);
  // Cancelled, specifically — not merely "not pending". A timer that ran would
  // also leave nothing pending, and that is the outcome this rules out.
  expect(h.timers.every((timer) => timer.cancelled && !timer.fired)).toBe(true);
});

test("a connection that announces twice is still one connection", () => {
  // The panel sends its hello whenever the channel reopens, and a transport that
  // drops and comes back reuses nothing — but a duplicate hello on one live
  // connection must not double every frame it receives.
  const h = harness();
  h.pusher.join("c1");
  h.pusher.join("c1");

  h.pusher.push("key-a");

  expect(h.sent).toHaveLength(1);
});

test("a key quiet for longer than the floor leads again rather than waiting", () => {
  // `lastSent` is measured, not assumed. A key that earns once an hour should
  // never see its frame deferred: the floor has long since passed.
  const h = harness();
  h.pusher.join("c1");

  h.pusher.push("key-a");
  h.advance(PUSH_FLOOR_MS * 10);
  h.pusher.push("key-a");

  expect(h.keys()).toEqual(["key-a", "key-a"]);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
});
// ------------------------------------------------------------------- the fleet

/**
 * The half a single process cannot test for itself.
 *
 * A `connectionId` means something only on the replica whose socket produced it,
 * so a plugin answering with `send` alone reaches the panels that happen to
 * share a pod with it. These four assertions are the difference between a panel
 * that keeps up on a cluster and one that goes quiet with its poll switched off.
 */
test("with a broadcast available a frame goes to the fleet, not to local sockets", () => {
  const h = harness(PUSH_FLOOR_MS, true);
  h.pusher.join("c1");

  h.pusher.push("key-a");

  expect(h.fanned).toEqual([{ apiKeyId: "key-a" }]);
  // Not both: the host loops the broadcast back into this process's own
  // subscribers, so sending here as well would deliver every frame twice.
  expect(h.sent).toEqual([]);
});

test("a frame goes out with nobody connected to this replica", () => {
  // The property this deliberately gives up. "No audience, no work" was measured
  // against one process's listener set, and on a fleet that set says nothing
  // about where the panel actually is — suppressing on it is what made the
  // cluster's panel go quiet.
  const h = harness(PUSH_FLOOR_MS, true);

  h.pusher.push("key-a");

  expect(h.fanned).toEqual([{ apiKeyId: "key-a" }]);
});

test("the floor still applies to a broadcast, per key", () => {
  const h = harness(PUSH_FLOOR_MS, true);

  h.pusher.push("key-a");
  h.pusher.push("key-a");
  h.pusher.push("key-b");
  expect(h.fanned).toEqual([{ apiKeyId: "key-a" }, { apiKeyId: "key-b" }]);

  h.advance(PUSH_FLOOR_MS);
  // The trailing frame of key-a's burst, and nothing for key-b, which sent once.
  expect(h.fanned).toEqual([{ apiKeyId: "key-a" }, { apiKeyId: "key-b" }, { apiKeyId: "key-a" }]);
});

test("a broadcasting pusher keeps its pending frame when the last local socket leaves", () => {
  // The audience is elsewhere. Cancelling on an empty *local* set would drop the
  // trailing frame of a burst for every panel on every other replica.
  const h = harness(PUSH_FLOOR_MS, true);
  h.pusher.join("c1");
  h.pusher.push("key-a");
  h.pusher.push("key-a");

  h.pusher.leave("c1");
  h.advance(PUSH_FLOOR_MS);

  expect(h.fanned).toEqual([{ apiKeyId: "key-a" }, { apiKeyId: "key-a" }]);
});
