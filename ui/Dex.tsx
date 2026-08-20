import { useState } from "react";
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
  Dim,
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
      <Row>
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
      </Row>

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
            return [
              <Cell
                $open={open}
                aria-controls={detailId}
                aria-expanded={open}
                key={entry.id}
                onClick={() => setOpenId(open ? null : entry.id)}
                type="button"
              >
                <img
                  // The species number stays in the alt text when there is no
                  // name: an alt is read aloud in a sentence, and `#3` is not a
                  // word.
                  alt={`${entry.rarity}${entry.isShiny ? " shiny" : ""} ${
                    entry.name ?? `species ${entry.finalId}`
                  }`}
                  src={spriteUrl(pluginId, entry.finalId, entry.isShiny)}
                  style={{ width: "64px", height: "64px", imageRendering: "pixelated" }}
                />
                <Caption>{speciesLabel(entry.name, entry.finalId)}</Caption>
                {/*
                  Nature is captioned rather than folded into the sprite's alt
                  text: the alt text names the thing, and a nullable field inside
                  an accessible name makes the name of an old entry differ from
                  the name of a new one for no reason a reader could guess.
                */}
                {entry.nature === null ? null : <Caption>{entry.nature}</Caption>}
              </Cell>,
              open ? (
                <Detail entry={entry} id={detailId} key={detailId} pluginId={pluginId} />
              ) : null,
            ];
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
            <DexLineStage key={speciesId}>
              <img
                alt={spriteAlt(null, speciesId, false)}
                src={spriteUrl(pluginId, speciesId, false)}
              />
              <Caption>
                {index === entry.chainOrder.length - 1
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
