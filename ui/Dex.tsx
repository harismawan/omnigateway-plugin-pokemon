import { useState } from "react";
import { RARITY_FILTERS, speciesLabel, spriteUrl } from "./format.ts";
import { Button, Caption, Cell, DexGrid, Dim, Row } from "./primitives.ts";
import type { DexEntry, Rarity } from "./types.ts";

/**
 * The trophy case, filterable by rarity.
 *
 * The filter lives here rather than in the panel's own state because nothing
 * else on the panel reads it — a Dex with no entries has no filter to keep, and
 * hoisting it would mean the shop re-rendered when somebody clicked "legendary".
 */
export function Dex({ entries, pluginId }: { entries: readonly DexEntry[]; pluginId: string }) {
  const [rarityFilter, setRarityFilter] = useState<Rarity | null>(null);

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
            onClick={() => setRarityFilter(rarity)}
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
          {shown.map((entry) => (
            <Cell key={entry.id}>
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
            </Cell>
          ))}
        </DexGrid>
      )}
    </>
  );
}
