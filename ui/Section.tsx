import { type ReactNode, useId, useState } from "react";
import {
  FoldingHead,
  SectionCount,
  SectionMarker,
  SectionRule,
  SectionToggle,
} from "./primitives.ts";

/** The three sections that fold. The hero is not one: it is what the panel is. */
export type SectionKey = "shop" | "bag" | "dex";

export type SectionState = Record<SectionKey, boolean>;

/**
 * Open, all three of them.
 *
 * First paint is what the panel has always looked like, so nothing an operator
 * knows about it stops being true on upgrade. Folding is a thing they choose,
 * not a thing they arrive at.
 */
const ALL_OPEN: SectionState = { shop: true, bag: true, dex: true };

/**
 * Where the choice is kept between visits.
 *
 * Scoped by plugin id rather than a bare key, because this panel shares
 * `localStorage` with the whole console and with every other plugin loaded into
 * it. An unscoped `sections` would be a name two plugins could reasonably both
 * pick.
 */
const storageKey = (pluginId: string): string => `plugin:${pluginId}:sections`;

/**
 * Read the remembered state, treating anything unexpected as "no preference".
 *
 * Every failure lands in the same place, and there are more of them than there
 * look to be: storage disabled by policy, a quota error, a `localStorage` that
 * throws on access in a sandboxed frame, a value from an older version of this
 * panel, or JSON somebody edited by hand. None of them is worth an error state
 * — the fallback is the default layout, which is a perfectly good panel.
 *
 * Each key is narrowed on its own rather than the object being cast. A stored
 * `{"shop": "yes"}` would otherwise make `open.shop` a truthy string, which
 * works right up until something reads it as a boolean.
 */
function readSections(pluginId: string): SectionState {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(pluginId));
    if (raw === null || raw === undefined) return ALL_OPEN;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return ALL_OPEN;
    const record = parsed as Record<string, unknown>;
    return {
      shop: typeof record.shop === "boolean" ? record.shop : ALL_OPEN.shop,
      bag: typeof record.bag === "boolean" ? record.bag : ALL_OPEN.bag,
      dex: typeof record.dex === "boolean" ? record.dex : ALL_OPEN.dex,
    };
  } catch {
    return ALL_OPEN;
  }
}

/**
 * Which sections are open, remembered across visits.
 *
 * The write is best-effort in the same way `writeCache` is on the server: a
 * browser that refuses storage gets a panel whose sections still fold, they
 * just do not survive a reload. Persistence is a convenience, and a convenience
 * must not be able to take the panel down.
 *
 * Read once, in the initialiser, rather than in an effect. An effect would paint
 * the default layout for a frame and then collapse the sections underneath the
 * operator's cursor.
 */
export function useSections(pluginId: string): {
  open: SectionState;
  toggle: (key: SectionKey) => void;
} {
  const [open, setOpen] = useState<SectionState>(() => readSections(pluginId));

  const toggle = (key: SectionKey) => {
    setOpen((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        globalThis.localStorage?.setItem(storageKey(pluginId), JSON.stringify(next));
      } catch {
        // Intentionally swallowed; see above.
      }
      return next;
    });
  };

  return { open, toggle };
}

/**
 * A section of the panel that can be put away.
 *
 * The count is the reason a folded heading is worth reading: "BAG" tells an
 * operator nothing they did not already know, and "3 held" tells them whether
 * opening it is worth the click. It stays visible in both states, so folding a
 * section never costs the one fact it was showing at a glance.
 *
 * The body is unmounted rather than hidden. Everything inside these sections is
 * derived from data the panel already has — no section holds a query of its own
 * — so there is nothing to keep alive, and a hidden subtree would still be
 * reachable by a keyboard.
 */
export function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  /** What the section contains, phrased for a heading: "8 offers", "3 held". */
  count: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();

  return (
    <>
      <FoldingHead>
        <SectionToggle aria-controls={bodyId} aria-expanded={open} onClick={onToggle} type="button">
          <SectionMarker $open={open}>▶</SectionMarker>
          {title}
          <SectionRule />
          <SectionCount>{count}</SectionCount>
        </SectionToggle>
      </FoldingHead>
      {open ? <div id={bodyId}>{children}</div> : null}
    </>
  );
}
