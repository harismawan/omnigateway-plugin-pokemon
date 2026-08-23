import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatWhen, RARITY_FILTERS, spriteAlt, spriteUrl } from "./format.ts";
import {
  Button,
  Caption,
  CatchList,
  CatchMark,
  CatchRow,
  CatchWhen,
  Cell,
  Chip,
  DexChainLink,
  DexClose,
  DexDetail,
  DexDialog,
  DexFacts,
  DexField,
  DexFieldHead,
  DexGrid,
  DexHeading,
  DexLine,
  DexLineStage,
  DexPlate,
  DexRegister,
  DexWhen,
  Dim,
  FilterRow,
  Row,
  ShinyChip,
  SpeciesNumber,
} from "./primitives.ts";
import type { DexSpecies, Rarity } from "./types.ts";

/**
 * The value of a field whose fact does not exist yet.
 *
 * An em dash rather than an empty node, because a blank slot reads as a value
 * that failed to load. This one is a statement: the line has not graduated, so
 * there is no date to print and there is not supposed to be.
 */
const DASH = "—";

/** The mark for a shiny individual. A glyph, never a colour — see the panel's rule. */
const SHINY = "✦";

/**
 * The collection, filterable by rarity, with each species' record a click away.
 *
 * One cell per **species**, not per graduation: the server expands each stored
 * line into the species it contains, so a graduated Venusaur puts Bulbasaur,
 * Ivysaur and Venusaur on the grid, ordered by number the way a Pokédex prints
 * them. See `src/collection.ts` for why that expansion is a reading of the
 * stored row rather than a guess about it.
 *
 * The filter lives here rather than in the panel's own state because nothing
 * else on the panel reads it — a Dex with no entries has no filter to keep, and
 * hoisting it would mean the shop re-rendered when somebody clicked "legendary".
 * The selection lives here for the same reason, and for one more: the two are
 * coupled, and the coupling has to be enforced somewhere. See below.
 */
export function Dex({ entries, pluginId }: { entries: readonly DexSpecies[]; pluginId: string }) {
  const [rarityFilter, setRarityFilter] = useState<Rarity | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  /*
    The cell that opened the record, so focus can go back to it.

    Held rather than looked up again on close, because by then it may not be
    findable: the grid re-renders while the dialog is open — a poll can add a
    species, and the rarity filter can take this very cell off the grid — and
    "the button whose accessible name matches" is not a stable handle across
    that. The element itself is.
  */
  const opener = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpenId(null);
    // Restored by us rather than by the browser. `close()` returns focus to the
    // invoker only when the dialog was opened by a form control targeting it;
    // opened imperatively, focus lands back on `<body>` and the keyboard starts
    // over at the top of the console.
    opener.current?.focus();
  }, []);

  /*
    Names by species id, built from the **whole** collection and never from
    what is on screen.

    This is what lets a detail caption an evolution line without a second
    lookup: every stage of every line it can draw is itself a species in this
    array, because a line only reaches the panel by being some catch's
    `chainOrder` and every member of every `chainOrder` becomes a record.

    Built from `entries` rather than from `shown`, and the difference is
    visible: Eevee is common and Vaporeon is legendary, so filtering to
    legendary takes Eevee off the grid — and out of a map built from the
    filtered list, leaving Vaporeon's own record reading `#133 → #134 Vaporeon`
    for as long as the filter was on.
  */
  /*
    Every species in the collection, for the chain to hide what is not in it.

    Built from `entries` and not from `shown`, for the reason the name index is:
    filtering to "legendary" must not make a common pre-evolution vanish from
    the line drawn inside a record.
  */
  const obtained = useMemo(() => new Set(entries.map((entry) => entry.speciesId)), [entries]);

  const names = useMemo(() => {
    const index = new Map<number, string>();
    for (const entry of entries) {
      if (entry.name !== null) index.set(entry.speciesId, entry.name);
    }
    return index;
  }, [entries]);

  if (entries.length === 0) return <Dim>Nothing caught yet.</Dim>;

  const shown =
    rarityFilter === null ? entries : entries.filter((entry) => entry.rarity === rarityFilter);
  // Found in `entries` rather than in `shown`, so a record stays open across a
  // filter change that would have hidden its cell.
  const open = entries.find((entry) => entry.speciesId === openId);

  return (
    <>
      <FilterRow>
        {RARITY_FILTERS.map((rarity) => (
          // Pressed, not disabled. Disabling the active filter takes the one
          // control that says which filter is active out of the tab order, and
          // `aria-pressed` already says it — to a screen reader as well as to
          // the eye.
          <Button
            aria-pressed={rarityFilter === rarity}
            key={rarity ?? "all"}
            // The open record is deliberately *not* cleared here any more.
            // That rule existed because the detail lived in the grid, so
            // filtering away the cell it sat under left it describing a sprite
            // that was no longer on screen. A modal has no grid position to be
            // orphaned from, and closing it would throw away what the operator
            // was reading because they touched an unrelated control.
            onClick={() => setRarityFilter(rarity)}
            type="button"
          >
            {rarity ?? "all"}
          </Button>
        ))}
      </FilterRow>

      {shown.length === 0 ? (
        // Not "Nothing caught yet." A filter that hides everything and an empty
        // collection are different facts, and showing the second in place of
        // the first reads as a bug in the filter.
        <Dim>No {rarityFilter} species yet.</Dim>
      ) : (
        <DexGrid>
          {shown.map((entry) => {
            const open = openId === entry.speciesId;
            return (
              /*
                One cell, keyed by species. The record used to be a sibling here
                — the two were returned inside a keyed `Fragment`, because a bare
                `[cell, detail]` array is reconciled by *position* and made the
                grid index part of every cell's identity, remounting every sprite
                whenever a species appeared on a poll.

                The record is a dialog now and no longer lives in the grid at
                all, so the fragment has nothing to wrap. The key moves onto the
                cell itself and the hazard is gone rather than handled.
              */
              <Cell
                $open={open}
                // `haspopup`, not `expanded`. The cell summons something that
                // takes over the page rather than revealing a region that stays
                // part of it, and `aria-expanded` would describe a containment
                // relationship that does not exist. `aria-controls` goes with
                // it: the dialog is not in the grid's subtree to be controlled.
                aria-haspopup="dialog"
                key={entry.speciesId}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setOpenId(entry.speciesId);
                }}
                type="button"
              >
                <img
                  // The species number stays in the alt text when there is no
                  // name: an alt is read aloud in a sentence, and `#3` is not
                  // a word.
                  alt={`${entry.rarity}${entry.isShiny ? " shiny" : ""} ${
                    entry.name ?? `species ${entry.speciesId}`
                  }`}
                  src={spriteUrl(pluginId, entry.speciesId, entry.isShiny)}
                  style={{ width: "64px", height: "64px", imageRendering: "pixelated" }}
                />
                {/*
                    The number always, and the name only when there is one.

                    Not `speciesLabel`, which is the right helper where a single
                    slot has to hold whichever of the two exists — the detail's
                    heading, the evolution line. Here there are two slots, and
                    using it would print `#3` in both of them for a species the
                    cache has not resolved yet: the number, and then the number
                    again standing in for the name. A cell that repeats itself
                    reads as a rendering bug rather than as a cold cache.
                  */}
                <SpeciesNumber>#{entry.speciesId}</SpeciesNumber>
                {entry.name === null ? null : <Caption>{entry.name}</Caption>}
                {/*
                    Shininess and how many were caught, in one caption or none.

                    Nature used to sit here and no longer can: a cell is a
                    species now, and a nature belongs to an individual. It moved
                    into the record's catch list, where each catch carries its
                    own.

                    `× 1` is suppressed because a count that is always there
                    stops being information — the interesting fact is the second
                    one, not the first.
                  */}
                {tally(entry) === null ? null : <Caption>{tally(entry)}</Caption>}
              </Cell>
            );
          })}
        </DexGrid>
      )}

      {/*
        Outside the grid and outside the filter's empty branch, deliberately.
        A record is modal, so it does not belong to a cell's position — and
        rendering it inside the grid would tie its lifetime to whether its own
        species currently passes the filter, which is the coupling the dialog
        exists to remove. `open` is looked up against the whole collection for
        the same reason.
      */}
      {open === undefined ? null : (
        <Record
          entry={open}
          names={names}
          obtained={obtained}
          onClose={close}
          pluginId={pluginId}
        />
      )}
    </>
  );
}

/** `✦ × 2`, `✦`, `× 2`, or nothing at all when there is neither fact to state. */
function tally(entry: DexSpecies): string | null {
  const marks = [
    entry.isShiny ? SHINY : null,
    entry.catches.length > 1 ? `× ${entry.catches.length}` : null,
  ].filter((mark): mark is string => mark !== null);
  return marks.length === 0 ? null : marks.join(" ");
}

/**
 * One species' record, modal, in the top layer.
 *
 * Opened imperatively in an effect rather than with the `open` attribute, and
 * the two are not equivalent: `open` renders a *non-modal* dialog, in flow, with
 * no focus trap, no Escape, no backdrop and no inertness for the rest of the
 * page. Only `showModal()` gives any of that. Mounting the component is what
 * opens it, so the effect has no dependency but the ref.
 *
 * Escape is the browser's and is not exercised in the suite — happy-dom
 * implements `showModal`/`close` but not the user-agent key handling — so
 * `onClose` is wired to the element's own `close` event rather than to the
 * buttons alone. That way every route out, including the one the tests cannot
 * press, goes through the same place.
 */
function Record({
  entry,
  names,
  obtained,
  onClose,
  pluginId,
}: {
  entry: DexSpecies;
  names: ReadonlyMap<number, string>;
  /** Every species in the collection, so the chain can hide what is not in it. */
  obtained: ReadonlySet<number>;
  onClose: () => void;
  pluginId: string;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const headingId = `dex-record-${entry.speciesId}`;

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    return () => {
      // Closed on unmount as well as by the close event. Without this a record
      // whose species vanished from the collection mid-poll would leave a
      // top-layer element behind with nothing rendering into it.
      if (element.open) element.close();
    };
  }, []);

  return (
    <DexDialog
      aria-labelledby={headingId}
      onClick={(event) => {
        // The backdrop is the dialog element's own box; the card inside it is
        // `DexDetail`. So a click whose target *is* the dialog landed outside
        // the card — which is what "clicking the backdrop" means. Comparing
        // against `currentTarget` rather than checking `contains` is what keeps
        // a click on the heading from dismissing the record.
        if (event.target === event.currentTarget) onClose();
      }}
      // Fires for the close button, for Escape, and for `close()` — so the
      // panel's state cannot drift out of step with the element's.
      onClose={onClose}
      ref={dialog}
    >
      <DexClose aria-label="Close" onClick={onClose} type="button">
        ✕
      </DexClose>
      <DexDetail>
        {/*
          The specimen and what identifies it. Everything else the record knows
          is below the rule — an identity and a log are different kinds of
          thing, and separating them is what the flat column could not do.
        */}
        <DexPlate>
          <img
            alt={spriteAlt(entry.name, entry.speciesId, entry.isShiny)}
            src={spriteUrl(pluginId, entry.speciesId, entry.isShiny)}
          />
          <DexFacts>
            {/* Number in front of the name, the way a Pokédex prints one, and by
              the same two-slot rule the cell and the hero heading follow. */}
            <DexHeading id={headingId}>
              <SpeciesNumber>#{entry.speciesId}</SpeciesNumber>
              {entry.name === null ? null : entry.name}
            </DexHeading>
            <Row>
              <Chip>{entry.rarity}</Chip>
              {entry.isShiny ? <ShinyChip>{SHINY} shiny</ShinyChip> : null}
            </Row>
          </DexFacts>
        </DexPlate>

        <DexRegister>
          {/*
            What happened to the *line*, and which kind of date that is — said
            in the label rather than buried in the value.

            `firstCaughtExact` is false when no catch recorded an instant for
            this stage — every graduation from before the instants were stored —
            and `firstCaughtAt` is then the moment the *line* finished. For a
            pre-evolution those are months apart, so labelling a graduation
            "first caught" would date a Bulbasaur to its Venusaur.

            With no catches the line has not finished, and the slot holds a dash
            rather than vanishing. The register keeps the same fields in the
            same order whichever kind of record this is, so a reader learns one
            shape instead of two — and an absent fact stated is easier to read
            than a field that silently takes the layout with it.
          */}
          <DexField>
            <DexFieldHead>
              {entry.catches.length > 0 && entry.firstCaughtExact
                ? "first caught"
                : "line graduated"}
            </DexFieldHead>
            <DexWhen>{entry.catches.length === 0 ? DASH : formatWhen(entry.firstCaughtAt)}</DexWhen>
          </DexField>

          {/*
            One line per branch this species was actually caught through, drawn
            as it was stored rather than as the species cache currently resolves
            it. A stage whose name has not been fetched shows its number, the
            same fallback the grid uses, and fills in on a later poll.
          */}
          <DexField>
            <DexFieldHead>{entry.lines.length > 1 ? "evolutions" : "evolution"}</DexFieldHead>
            {entry.lines.map((line) => (
              <DexLine key={line.join("-")}>
                {/*
                  Only the stages this key has actually been.

                  A line is a *plan* until it is walked, so drawing the forms
                  ahead of a companion still growing would show a Pokédex entry
                  for something the player has never had — with a name and a
                  sprite, indistinguishable from one they earned. Filtered
                  before the map so the chain links land between the stages that
                  survive rather than leaving a rule pointing at nothing.

                  For a graduated line every stage is in the collection, so this
                  filters nothing and the chain is unchanged.
                */}
                {line
                  .filter((speciesId) => obtained.has(speciesId))
                  .map((speciesId, index) => (
                    /* A well-formed line cannot repeat a species — `lineThrough`
                   walks a tree — but `readDex` fails open and only drops chain
                   members that are not numbers, so a corrupt row reaches here
                   intact and `key={speciesId}` alone would be two identical
                   keys: a React bug stacked on a data one. The index belongs in
                   the key regardless, for the same reason it does in
                   `GrowthTrack`: a line is ordered, and a stage *is* its
                   position in it. */
                    // biome-ignore lint/suspicious/noArrayIndexKey: a stage is its position in the line
                    <Fragment key={`${speciesId}-${index}`}>
                      {index === 0 ? null : <DexChainLink aria-hidden="true" />}
                      {/* `aria-current` and not colour alone. The tile the
                        record is about is marked by an accent border and a
                        brighter caption, and neither of those reaches a screen
                        reader — so the state that makes the chain worth drawing
                        would have been visual-only. It is also the one part of
                        the marker a test can assert without reaching into
                        styled-components internals. */}
                      <DexLineStage
                        $here={speciesId === entry.speciesId}
                        aria-current={speciesId === entry.speciesId ? "true" : undefined}
                      >
                        <img
                          alt={spriteAlt(names.get(speciesId) ?? null, speciesId, false)}
                          src={spriteUrl(pluginId, speciesId, false)}
                        />
                        {/*
                          Number on its own line, name under it — the same two
                          slots the grid cell uses, and now drawn the same way.
                          A tile and a cell showing the same species should not
                          disagree about how they say so.

                          Both, on every stage. This used to name whichever
                          stage matched `final_id` and number the rest, so a
                          Venusaur's line read `#1 → #2 → Venusaur` — and
                          permanently, because no name was ever resolved for a
                          non-final stage at all.

                          Each stage is named from its own id through the
                          collection's own index, which is what makes the old
                          hazard impossible: a caption resolved by position
                          could print the graduate's name under whichever sprite
                          happened to be last, which on an Eevee line is
                          "Vaporeon" written under Eevee.

                          Two slots, so not `speciesLabel`: it would render the
                          number twice on a species the cache has not named.
                        */}
                        <SpeciesNumber>#{speciesId}</SpeciesNumber>
                        {names.has(speciesId) ? <Caption>{names.get(speciesId)}</Caption> : null}
                      </DexLineStage>
                    </Fragment>
                  ))}
              </DexLine>
            ))}
          </DexField>

          {/*
            The individuals behind the species. Nature lives here rather than on
            the cell because it belongs to one of them and not to all of them.

            A grid rather than the `date · nature · ✦` sentence this replaces: a
            log is read down a column, and dot-separated text gives the eye no
            column to run down.
          */}
          {/*
            Omitted rather than shown empty. An encounter is a completed line,
            and a species reached by a companion that is still growing has none
            — a heading over an empty list reads as a list that failed to load.
          */}
          {entry.catches.length === 0 ? null : (
            <DexField>
              <DexFieldHead>
                <span>{entry.catches.length === 1 ? "encounter" : "encounters"}</span>
                {/* The count only above one, for the reason the cell suppresses
                  `× 1`: a number that is always there stops being information. */}
                {entry.catches.length > 1 ? <span>{entry.catches.length}</span> : null}
              </DexFieldHead>
              <CatchList>
                {entry.catches.map((taken) => (
                  <CatchRow key={taken.id}>
                    {/* The stage instant, falling back to the graduation for a row
                      that never recorded one. Same rule as the field label
                      above, per individual. */}
                    <CatchWhen>{formatWhen(taken.enteredAt ?? taken.caughtAt)}</CatchWhen>
                    {/* Null for a graduation recorded before natures were stored,
                      which is an absent fact rather than an unknown one — so an
                      empty cell, rather than the word "unknown". */}
                    <span>{taken.nature ?? ""}</span>
                    {taken.isShiny ? <CatchMark>{SHINY}</CatchMark> : <span />}
                  </CatchRow>
                ))}
              </CatchList>
            </DexField>
          )}

          {/*
            The same slot, for a species whose companion is still walking its
            line and so has no catches to list.

            The heading is `encounter` either way, because to a reader it is the
            same fact at both scales: when this key met this species. The list
            above happens to have an individual behind each row and this does
            not, which is a distinction in the data rather than one worth a
            second word on the panel.

            The instant is when the sighting was written down, which for a stage
            entered before instants were stored is the first settle after the
            upgrade rather than the evolution. That imprecision is not called
            out here — the catch rows above already print `enteredAt ?? caughtAt`
            unqualified, so flagging it in one slot and not the other would be a
            strictness the register does not keep. Telling the two apart needs a
            `seen_exact` column; until then see `contributionOf` in
            `src/collection.ts`.
          */}
          {entry.catches.length === 0 ? (
            <DexField>
              <DexFieldHead>encounter</DexFieldHead>
              <DexWhen>{formatWhen(entry.firstCaughtAt)}</DexWhen>
            </DexField>
          ) : null}
        </DexRegister>
      </DexDetail>
    </DexDialog>
  );
}
