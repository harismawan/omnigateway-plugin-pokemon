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
function harness(floorMs = PUSH_FLOOR_MS) {
  let now = NOW;
  const sent: Array<{ connectionId: string; payload: unknown }> = [];
  /** Armed timers, newest last, each with the delay it was asked for. */
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];

  const schedule: Schedule = (run, ms) => {
    const timer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  const pusher = createPusher({
    send: (connectionId, payload) => sent.push({ connectionId, payload }),
    now: () => now,
    floorMs,
    schedule,
  });

  return {
    pusher,
    sent,
    timers,
    /** Fires every armed, uncancelled timer whose delay has elapsed. */
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.cancelled) continue;
        timer.cancelled = true;
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
  expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
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
