import { useState } from "react";
import { itemSpriteUrl } from "./format.ts";
import { ItemIconImage, ItemIconSlot } from "./primitives.ts";

/**
 * An item's icon, with its emoji underneath it.
 *
 * The fallback is driven by the image's own `error` event rather than by
 * anything the panel knows in advance, and that is what makes one path cover
 * three unrelated absences:
 *
 * - `mint`, which has no sprite in the PokéAPI repository and never will, so
 *   the route answers 404 on every install forever.
 * - A cold cache, where **every** icon 404s on first paint and fills in on a
 *   later poll. This is the panel's existing stance that a cold cache is an
 *   ordinary state rather than an error — the same stance that lets a species
 *   render as `#25` until its name arrives.
 * - An offline or air-gapped install, where the route answers 503 and no icon
 *   is ever coming.
 *
 * Asking the server which of those it was would be a second request to answer a
 * question with one visual answer.
 *
 * Both forms are decorative: the card's own text names the item, so an icon
 * with an accessible name would make a screen reader say "rare candy" twice.
 * `alt=""` and `aria-hidden` are the same claim made to the two things that
 * read them.
 */
export function ItemIcon({
  item,
  emoji,
  pluginId,
}: {
  /** The stored id, or `egg` — whatever the server's sprite map is keyed by. */
  item: string;
  emoji: string;
  pluginId: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <ItemIconSlot aria-hidden="true">
      {failed ? (
        emoji
      ) : (
        <ItemIconImage alt="" onError={() => setFailed(true)} src={itemSpriteUrl(pluginId, item)} />
      )}
    </ItemIconSlot>
  );
}
