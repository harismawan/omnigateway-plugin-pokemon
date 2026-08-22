import { Fragment, useState } from "react";
import { RARITY_FILTERS, speciesLabel, spriteAlt, spriteUrl } from "./format.ts";
import {
  Button,
  Caption,
  Cell,
  Chip,
  DexDetail,
  DexFacts,
  DexGrid,
  DexLine,
  DexLineStage,
  DexNumber,
  Dim,
  FilterRow,
  Row,
  ShinyChip,
} from "./primitives.ts";
import type { DexEntry, Rarity } from "./types.ts";

/**
 * The trophy case, filterable by rarity, with each graduate's record a click
 * away.
 *
 * The filter lives here rather than in the panel's own state because nothing
 * else on the panel reads it — a Dex with no entries has no filter to keep, and
 * hoisting it would mean the shop re-rendered when somebody clicked "legendary".
 * The selection lives here for the same reason, and for one more: the two are
 * coupled, and the coupling has to be enforced somewhere. See below.
 */
export function Dex({ entries, pluginId }: { entries: readonly DexEntry[]; pluginId: string }) {
  const [rarityFilter, setRarityFilter] = useState<Rarity | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  if (entries.length === 0) return <Dim>Nothing graduated yet.</Dim>;

  const shown =
    rarityFilter === null ? entries : entries.filter((entry) => entry.rarity === rarityFilter);

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
            onClick={() => {
              setRarityFilter(rarity);
              // The open record is cleared with the filter, because narrowing
              // to "legendary" can take the open entry off the grid entirely.
              // A detail panel describing a sprite that is no longer on screen
              // is the same class of lie as a bag listing something it does not
              // hold — and worse here, because the panel would sit under a grid
              // of unrelated Pokémon looking like one of theirs.
              setOpenId(null);
            }}
            type="button"
          >
            {rarity ?? "all"}
          </Button>
        ))}
      </FilterRow>

      {shown.length === 0 ? (
        // Not "Nothing graduated yet." A filter that hides everything and an
        // empty collection are different facts, and showing the second in place
        // of the first reads as a bug in the filter.
        <Dim>No {rarityFilter} graduates yet.</Dim>
      ) : (
        <DexGrid>
          {shown.map((entry) => {
            const open = openId === entry.id;
            const detailId = `dex-detail-${entry.id}`;
            return (
              /*
                A keyed `Fragment`, and the bare array it replaces was a real
                bug rather than a style preference.

                Returning `[cell, detail]` looks keyed — both children carry
                one — but React reconciles an *unkeyed nested array* as an
                implicit fragment matched by position, so the outer index
                became part of each cell's identity. `readDex` orders by
                `caught_at DESC`, so one new graduation arriving on a poll
                shifted every index and remounted the whole grid: every sprite
                destroyed and refetched, and a focused cell losing focus
                underneath the keyboard.

                The fragment is transparent to the grid — it creates no DOM
                node, so the cell and the detail stay direct children and the
                `1 / -1` placement below is unaffected.
              */
              <Fragment key={entry.id}>
                <Cell
                  $open={open}
                  aria-controls={detailId}
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : entry.id)}
                  type="button"
                >
                  <img
                    // The species number stays in the alt text when there is no
                    // name: an alt is read aloud in a sentence, and `#3` is not
                    // a word.
                    alt={`${entry.rarity}${entry.isShiny ? " shiny" : ""} ${
                      entry.name ?? `species ${entry.finalId}`
                    }`}
                    src={spriteUrl(pluginId, entry.finalId, entry.isShiny)}
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
                  <DexNumber>#{entry.finalId}</DexNumber>
                  {entry.name === null ? null : <Caption>{entry.name}</Caption>}
                  {/*
                    Nature is captioned rather than folded into the sprite's alt
                    text: the alt text names the thing, and a nullable field
                    inside an accessible name makes the name of an old entry
                    differ from the name of a new one for no reason a reader
                    could guess.
                  */}
                  {entry.nature === null ? null : <Caption>{entry.nature}</Caption>}
                </Cell>
                {open ? <Detail entry={entry} id={detailId} pluginId={pluginId} /> : null}
              </Fragment>
            );
          })}
        </DexGrid>
      )}
    </>
  );
}

/**
 * One graduate's record, sitting in the grid immediately after its own cell.
 *
 * A sibling of the cells rather than a child of one, which is what lets it span
 * every column — see `DexDetail` for why that placement needs no column count.
 */
function Detail({ entry, id, pluginId }: { entry: DexEntry; id: string; pluginId: string }) {
  return (
    <DexDetail id={id}>
      <img
        alt={spriteAlt(entry.name, entry.finalId, entry.isShiny)}
        src={spriteUrl(pluginId, entry.finalId, entry.isShiny)}
        style={{ width: "96px", height: "96px", imageRendering: "pixelated" }}
      />
      <DexFacts>
        <strong>{speciesLabel(entry.name, entry.finalId)}</strong>
        <Row>
          <Chip>{entry.rarity}</Chip>
          {entry.isShiny ? <ShinyChip>✦ shiny</ShinyChip> : null}
          {/* Null for a graduation recorded before natures were stored, which
              is an absent fact rather than an unknown one — so no chip at all,
              rather than a chip reading "unknown". */}
          {entry.nature === null ? null : <Chip>{entry.nature}</Chip>}
        </Row>

        {/*
          The line as it was actually stored, not as the species cache currently
          resolves it. A stage whose name has not been fetched shows its number,
          the same fallback the grid uses, and fills in on a later poll.
        */}
        <DexLine>
          {entry.chainOrder.map((speciesId, index) => (
            /* A well-formed line cannot repeat a species — `lineThrough` walks
               a tree — but `readDex` fails open and only drops chain members
               that are not numbers, so a corrupt row reaches here intact and
               `key={speciesId}` alone would be two identical keys: a React bug
               stacked on a data one. The index belongs in the key regardless,
               for the same reason it does in `GrowthTrack`: a line is ordered,
               and a stage *is* its position in it. */
            // biome-ignore lint/suspicious/noArrayIndexKey: a stage is its position in the line
            <DexLineStage key={`${speciesId}-${index}`}>
              <img
                alt={spriteAlt(null, speciesId, false)}
                src={spriteUrl(pluginId, speciesId, false)}
              />
              {/*
                Named by comparison with `finalId`, not by being last in the
                array. `name` is the name the server resolved *for `finalId`*,
                and `final_id` is a separate column from `chain_order` — they
                agree when written and can disagree when read, because
                `readDex` drops a non-numeric chain member while leaving
                `final_id` untouched. Captioning by position then writes the
                graduate's name under whichever sprite happens to be last,
                which on an Eevee line is "Vaporeon" printed under Eevee.
              */}
              <Caption>
                {speciesId === entry.finalId
                  ? speciesLabel(entry.name, speciesId)
                  : `#${speciesId}`}
              </Caption>
            </DexLineStage>
          ))}
        </DexLine>

        <Dim>caught {new Date(entry.caughtAt).toLocaleDateString()}</Dim>
      </DexFacts>
    </DexDetail>
  );
}
