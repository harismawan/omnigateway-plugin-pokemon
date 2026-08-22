import { definePluginUI, type PluginUiProps, useLive } from "@omnigateway/dashboard-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bag } from "./Bag.tsx";
import { Dex } from "./Dex.tsx";
import { activityOf } from "./format.ts";
import { Hero } from "./Hero.tsx";
import { KeyPicker } from "./KeyPicker.tsx";
import { Button, Dim, KeyId, Notice, Panel, PanelHead } from "./primitives.ts";
import { Section, useSections } from "./Section.tsx";
import { Shop } from "./Shop.tsx";
import type { CompanionView, Roster, ShopEntry } from "./types.ts";

/**
 * The companion panel.
 *
 * Two screens: the roster of keys that have companions, and one key's
 * companion. The roster is what this panel gained and it is the whole reason
 * the rest was rearranged — before it, the first thing the panel did was ask for
 * an API key id, and there is nowhere in the console to read one from.
 *
 * Re-exports `activityOf` because it was exported from this module before the
 * split and the derivation is the one piece of panel logic worth testing without
 * a renderer. Moving where a tested symbol lives is not a reason to move where
 * it is imported from.
 */
export { activityOf } from "./format.ts";

/**
 * How often the panel refetches, when the console is polling at all.
 *
 * Growth arrives from requests this panel has no way to hear about, so without
 * a poll an operator watching a companion evolve is watching a screenshot. The
 * interval is loose on purpose: the numbers move in tokens per request and
 * nothing here is worth a socket.
 *
 * Ten seconds rather than the fifteen this started at, matching what the
 * console's own credential-health boards use. Nothing about a companion demands
 * the tighter number; sharing one with the rest of the console is worth more
 * than a figure chosen alone.
 *
 * It is a *ceiling*, not a schedule. Every interval below goes through
 * `cadence`, which returns `false` while the chassis LIVE switch is paused —
 * see the note on `useLive` in the panel body.
 */
const REFETCH_MS = 10_000;

/**
 * Which screen the panel is on.
 *
 * Three cases and not two, because "the roster has not arrived yet" and "the
 * operator asked to be back at the roster" are different facts that a single
 * nullable key id cannot hold apart.
 *
 * They were held in one `string | null` at first, and the bug that came out of
 * it is worth recording. `showing = keyId ?? onlyKey` re-derived the open key
 * from *live* roster data on every render, so the auto-open fired again — in
 * both directions — every time the roster crossed the one-key boundary:
 *
 * - A companion the panel had opened by itself closed the instant a second key
 *   earned its first tokens. A purchase refetches the roster, so an operator
 *   buying a candy on a one-key install could be thrown back to the picker
 *   mid-transaction.
 * - "All keys" was undone on the next render if the roster happened to shrink
 *   back to one key, re-opening the very companion the operator had just left.
 *
 * Auto-opening is a decision made once, when the roster first arrives. It is
 * not a function of what the roster currently contains.
 */
type Screen =
  /** Before the first roster answers. Nothing has been decided. */
  | { at: "start" }
  /** The roster, whether it was never left or was deliberately returned to. */
  | { at: "roster" }
  | { at: "key"; apiKeyId: string };

function Companion({ pluginId, api }: PluginUiProps) {
  const [screen, setScreen] = useState<Screen>({ at: "start" });
  const client = useQueryClient();

  /**
   * The console's own LIVE switch, not a setting of this panel's.
   *
   * Polling is the gateway's only push mechanism, so the console pauses every
   * screen from one control in its chassis bar rather than hiding a toggle per
   * screen — and a plugin panel that kept polling through a pause would make
   * that control a lie on the one screen nobody thought to check.
   *
   * `cadence(ms)` is `ms` while live and `false` while paused, which is exactly
   * what react-query's `refetchInterval` wants. Outside the console — this
   * package's own test harness, or a panel rendered bare — there is no provider
   * and `cadence` returns `false`, so nothing polls. That is the right default:
   * a panel that cannot find the switch should not decide the answer is "poll
   * anyway".
   *
   * This works only because the console serves one copy of
   * `@omnigateway/dashboard-sdk` through its import map and `build:ui` marks it
   * external. Bundling it would give this panel its own `LiveContext`, no
   * provider above it, and a permanent `false` — a panel that silently never
   * refreshes, with nothing thrown and nothing logged.
   */
  const { cadence } = useLive();

  const roster = useQuery({
    queryKey: ["roster"],
    queryFn: () => api.get<Roster>("keys"),
    // The roster did not poll at all before this. A purchase invalidates it, so
    // it was fresh for whoever was buying — and stale for anyone watching a
    // second key earn its first tokens, which is the one thing the roster
    // screen is for.
    refetchInterval: cadence(REFETCH_MS),
  });

  const keys = roster.data?.keys ?? [];

  /**
   * Leave `start` the moment the first roster resolves, and never again.
   *
   * Adjusting state during render rather than from an effect: React discards
   * this pass and re-renders immediately, so the panel never paints the roster
   * for a frame before jumping into the only key on it. The `at === "start"`
   * guard is what makes it terminate — after this the screen is `roster` or
   * `key`, and neither is recomputed from the roster again.
   *
   * `!isPending` rather than `isSuccess`, so an unreachable roster also leaves
   * `start`: it lands on the picker, which is where the fallback field is.
   */
  if (screen.at === "start" && !roster.isPending) {
    const only = keys.length === 1 ? keys[0] : undefined;
    // A picker offering one choice is a click asked for nothing, and most
    // installs have one key doing the work.
    setScreen(only === undefined ? { at: "roster" } : { at: "key", apiKeyId: only.apiKeyId });
  }

  const showing = screen.at === "key" ? screen.apiKeyId : null;

  const companion = useQuery({
    queryKey: ["companion", showing],
    queryFn: () => api.get<CompanionView>(`keys/${showing}`),
    enabled: showing !== null,
    refetchInterval: cadence(REFETCH_MS),
  });

  // A money surface that fails silently is worse than one that fails loudly.
  // A 409 carries the reason — insufficient, unreadable, missing — and the
  // operator gets it rather than a panel that refetches and looks unchanged.
  const [refusal, setRefusal] = useState<string | null>(null);
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["companion", showing] });
    // The roster too: a purchase changes the wallet a card shows, and a fresh
    // egg changes the sprite on it.
    void client.invalidateQueries({ queryKey: ["roster"] });
  };

  const buy = useMutation({
    mutationFn: (entry: ShopEntry) => api.post(`keys/${showing}/purchase`, entry),
    onMutate: () => setRefusal(null),
    onError: (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : "the purchase was refused"),
    onSuccess: invalidate,
  });

  // The other half of a grant, and the reason the bag exists at all: the `use`
  // route was written so a granted candy could be spent, and until this
  // mutation nothing in the console ever called it. Same shape as `buy` on
  // purpose — one refusal surface, one invalidation.
  const use = useMutation({
    mutationFn: (item: string) => api.post(`keys/${showing}/use`, { item }),
    onMutate: () => setRefusal(null),
    onError: (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : "the item could not be used"),
    onSuccess: invalidate,
  });

  // Its own mutation rather than another `use`, mirroring the server: taking an
  // everstone off spends nothing, and routing it through the item path would
  // require holding a spare stone to release the one already on.
  const release = useMutation({
    mutationFn: () => api.post(`keys/${showing}/unpin`),
    onMutate: () => setRefusal(null),
    onError: (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : "the companion could not be released"),
    onSuccess: invalidate,
  });

  if (roster.isPending) return <Panel>Loading…</Panel>;

  if (showing === null) {
    return (
      <KeyPicker
        keys={keys}
        onPick={(apiKeyId) => setScreen({ at: "key", apiKeyId })}
        pluginId={pluginId}
        rosterFailed={roster.isError}
      />
    );
  }

  return (
    <Panel>
      <PanelHead>
        <h2>Companion</h2>
        <KeyId>{showing}</KeyId>
        {/*
          Always offered, and it took two wrong versions to get here.

          Gated on `keys.length > 1`, an operator whose roster was empty or
          unreachable typed a key id, arrived, and was stuck — the roster is
          precisely what is missing in that case, so its length answered
          "nowhere to go back to" about the one screen they needed.

          Gated on "did the operator choose this key", a panel that had opened
          itself onto a single key offered nothing, on the theory that returning
          to a picker of one would be a control that did nothing twice. That was
          true only while the roster could re-open a key by itself. It cannot
          any more, and the picker is where the key-id field lives — so on a
          one-key install this is the only route to a key that has no companion
          row yet, which is exactly the key the roster cannot list.
        */}
        <Button onClick={() => setScreen({ at: "roster" })} type="button">
          All keys
        </Button>
      </PanelHead>

      <CompanionBody
        buy={buy.mutate}
        buying={buy.isPending}
        keyId={showing}
        onRelease={() => release.mutate()}
        onUse={use.mutate}
        pluginId={pluginId}
        query={companion}
        refusal={refusal}
        releasing={release.isPending}
        using={use.isPending}
      />
    </Panel>
  );
}

/**
 * Everything below the key line, once there is a key.
 *
 * Split out so the loading and error states sit beside the states they replace
 * rather than above the heading — the heading and the key id stay put while the
 * body swaps, which is what keeps a refetch from making the panel jump.
 */
function CompanionBody({
  query,
  pluginId,
  buy,
  onUse,
  onRelease,
  buying,
  using,
  releasing,
  refusal,
}: {
  query: { isPending: boolean; isError: boolean; data: CompanionView | undefined };
  keyId: string;
  pluginId: string;
  buy: (entry: ShopEntry) => void;
  onUse: (item: string) => void;
  onRelease: () => void;
  buying: boolean;
  using: boolean;
  releasing: boolean;
  refusal: string | null;
}) {
  // Before the early returns, because a hook has to be. Which is also the right
  // place for it on its own terms: the choice of which sections are folded
  // belongs to the panel, not to whichever companion happens to be loaded, and
  // reading it here means it survives switching keys.
  const { open, toggle } = useSections(pluginId);

  if (query.isPending) return <Dim>Loading…</Dim>;
  if (query.isError || query.data === undefined) {
    return <Dim>No companion for that key yet.</Dim>;
  }

  const view = query.data;

  // Null and "no companion yet" are different facts, and the host is careful to
  // keep them apart — so this must too. A save that cannot be read is a reason
  // to look at the database, not a reason to start again.
  if (view.state === null) {
    return (
      <Notice>
        This key's save could not be read. It has been left untouched rather than replaced — nothing
        has been lost, but it needs looking at.
      </Notice>
    );
  }

  // Read at render rather than held in state: the panel repaints on every
  // refetch, and a clock kept in state would need a timer whose only job is to
  // make the word "idle" appear a few seconds earlier.
  const activity = activityOf(view.state.active !== null, view.lastCreditAt, Date.now());

  // What the bag would show, counted the way the bag counts it. `freshState`
  // writes every item at zero, so the number of *keys* in the inventory is the
  // size of the catalogue rather than the size of the bag.
  const held = Object.values(view.state.inventory).filter((count) => count > 0).length;

  return (
    <>
      <Hero
        activity={activity}
        onRelease={onRelease}
        pluginId={pluginId}
        releasing={releasing}
        view={view}
      />

      <Section
        count={countOf(view.shop.length, "offer")}
        onToggle={() => toggle("shop")}
        open={open.shop}
        title="Shop"
      >
        <Shop
          hasCompanion={view.state.active !== null}
          inventory={view.state.inventory}
          offers={view.shop}
          onBuy={buy}
          pending={buying}
          pluginId={pluginId}
          wallet={view.wallet}
        />
      </Section>

      <Section count={`${held} held`} onToggle={() => toggle("bag")} open={open.bag} title="Bag">
        <Bag inventory={view.state.inventory} onUse={onUse} pending={using} pluginId={pluginId} />
      </Section>

      {/*
        Outside both sections, deliberately. A refusal is the answer to
        something the operator just clicked, and folding the shop away must not
        take the reason a purchase failed with it.
      */}
      {refusal === null ? null : <Notice role="alert">{refusal}</Notice>}

      <Section
        count={countOf(view.dex.length, "species", "species")}
        onToggle={() => toggle("dex")}
        open={open.dex}
        title="Pokédex"
      >
        <Dex entries={view.dex} pluginId={pluginId} />
      </Section>
    </>
  );
}

/**
 * What a folded heading says it contains.
 *
 * Plural by hand rather than through a formatter: three words need pluralising
 * on this panel and a dependency or a helper table would be more machinery than
 * the problem has. Two of the three are regular and take the default; "species"
 * is its own plural and passes itself, which is cheaper than the alternative —
 * a rule that guesses — and impossible to get subtly wrong.
 */
function countOf(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

export default definePluginUI({ mount: Companion });
