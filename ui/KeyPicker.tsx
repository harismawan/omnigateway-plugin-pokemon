import { useState } from "react";
import { activityOf, formatTokens, speciesLabel, spriteAlt, spriteUrl } from "./format.ts";
import {
  BrokenMark,
  Button,
  Chip,
  Dim,
  EggMark,
  KeyCard,
  KeyId,
  Lede,
  Numeric,
  Panel,
  RosterGrid,
  Row,
  SectionHead,
  Sprite,
} from "./primitives.ts";
import type { RosterKey } from "./types.ts";

/**
 * The panel's front door.
 *
 * What this replaces was a bare text field asking for an API key id, and there
 * was nowhere in the console to read one from — so the first thing the panel
 * ever did was ask a question only the database could answer. The roster is
 * built from the plugin's own companion rows, which is a set it *can*
 * enumerate: a key with no row has never spent a token and so has no companion
 * to show.
 *
 * The field stays, one fold down, because the roster cannot be complete. A key
 * minted a minute ago has no row yet, and an install whose roster route is
 * unreachable still has companions worth reaching by id.
 */
export function KeyPicker({
  keys,
  onPick,
  pluginId,
  rosterFailed,
}: {
  keys: readonly RosterKey[];
  onPick: (apiKeyId: string) => void;
  pluginId: string;
  /** True when the roster could not be fetched, as opposed to being empty. */
  rosterFailed: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <Panel>
      <h2>Companion</h2>
      <Lede>Each API key raises its own Pokémon on the tokens it spends. Pick a key.</Lede>

      {keys.length > 0 ? (
        <RosterGrid>
          {keys.map((key) => (
            <RosterCard key={key.apiKeyId} entry={key} onPick={onPick} pluginId={pluginId} />
          ))}
        </RosterGrid>
      ) : (
        <Dim>
          {rosterFailed
            ? // Two different facts, and merging them would tell an operator
              // with a broken backend that their companions do not exist.
              "The list of keys could not be loaded. Enter a key id below to reach a companion directly."
            : "No key has spent a token yet. A companion appears the first time a key serves a request."}
        </Dim>
      )}

      <SectionHead>Or by key id</SectionHead>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (trimmed !== "") onPick(trimmed);
        }}
      >
        <Row>
          <input
            aria-label="API key id"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="key id"
            value={draft}
          />
          <Button type="submit">Show</Button>
        </Row>
      </form>
    </Panel>
  );
}

/**
 * One key, as much of its companion as a card can hold.
 *
 * The accessible name is assembled from the whole card, so it reads as "Pikachu
 * rare key_7f3a 4.2M working" — the key id included, because that is the string
 * an operator matches against the console's own key list.
 */
function RosterCard({
  entry,
  onPick,
  pluginId,
}: {
  entry: RosterKey;
  onPick: (apiKeyId: string) => void;
  pluginId: string;
}) {
  const activity = activityOf(entry.speciesId !== null, entry.lastCreditAt, Date.now());

  return (
    <KeyCard onClick={() => onPick(entry.apiKeyId)} type="button">
      {/*
        Three marks for three states, and the third is why they are not two. An
        unreadable save has no species either, so folding it in with the egg
        would draw a broken companion as one that simply has not hatched — the
        one confusion this plugin refuses to make anywhere else.
      */}
      {entry.unreadable ? (
        <BrokenMark aria-label="This key's save could not be read" role="img" />
      ) : entry.speciesId === null ? (
        <EggMark aria-label="An egg, not yet hatched" role="img" />
      ) : (
        <Sprite
          alt={spriteAlt(entry.name, entry.speciesId, entry.isShiny)}
          src={spriteUrl(pluginId, entry.speciesId, entry.isShiny)}
        />
      )}

      <strong>
        {entry.unreadable
          ? "Save unreadable"
          : entry.speciesId === null
            ? "Egg"
            : speciesLabel(entry.name, entry.speciesId)}
      </strong>

      {entry.rarity === null ? null : <Chip>{entry.rarity}</Chip>}
      <KeyId>{entry.apiKeyId}</KeyId>
      <Dim>
        <Numeric>{formatTokens(entry.tokensTotal)}</Numeric>
        {/* No activity for a save that cannot be read: the column it would be
            derived from is fine, but "idle" beside "Save unreadable" reads as a
            companion that is merely resting. */}
        {entry.unreadable ? null : ` · ${activity}`}
      </Dim>
    </KeyCard>
  );
}
