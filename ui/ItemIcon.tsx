import { useState } from "react";
import { itemSpriteUrl } from "./format.ts";
import { ItemIconImage, ItemIconSlot } from "./primitives.ts";

/**
 * An item's icon, with its emoji underneath it.
 *
 * The fallback is driven by the image's own `error` event rather than by
 * anything the panel knows in advance, and that is what makes one path cover
 * two unrelated absences:
 *
 * - A cold cache, where **every** icon 404s on first paint and fills in on a
 *   later poll. This is the panel's existing stance that a cold cache is an
 *   ordinary state rather than an error — the same stance that lets a species
 *   render as `#25` until its name arrives.
 * - An offline or air-gapped install, where the route answers 503 and no icon
 *   is ever coming.
 *
 * There used to be a third: `mint` shipped with no sprite mapped, so the route
 * 404ed for it on every install forever. That is what the emoji was covering,
 * and covering it in the panel left a permanent error in the browser console
 * for a request that was never going to succeed. It is mapped now, and the two
 * absences left are both temporary or install-wide rather than per-item.
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
