import { useState } from "react";
import { eggSpriteUrl } from "./format.ts";
import { EggImage, EggMark, EggSlot } from "./primitives.ts";

/**
 * A companion that has not hatched, with the drawn egg underneath it.
 *
 * The same shape as `ItemIcon` and for the same reasons: the fallback is driven
 * by the image's own `error` event rather than by anything the panel knows in
 * advance, because the two absences it covers are indistinguishable from here
 * and have one visual answer.
 *
 * - A cold cache, where the icon 404s on first paint and fills in on a later
 *   poll. This is the panel's standing position that a cold cache is an ordinary
 *   state rather than an error — the same one that lets a species render as
 *   `#25` until its name arrives.
 * - An install without `net`, where the route answers 503 and no art is ever
 *   coming.
 *
 * Asking the server which it was would be a second request to answer a question
 * with one answer.
 *
 * **The accessible name is identical on both branches**, which is the part that
 * matters most here and the part a refactor is most likely to drop. An egg is
 * the companion, not decoration beside it, so unlike `ItemIcon` this is not
 * `aria-hidden` — and a screen reader must not be able to tell whether the
 * artwork loaded. The panel's tests query this by name in four places.
 *
 * Not `Sprite`: that element fills the whole 192px slot, which is right for a
 * 96px species GIF at 2× and wrong for a 30px item PNG. See `EggImage`.
 */
export function EggSprite({ pluginId }: { pluginId: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <EggMark aria-label={EGG_LABEL} role="img" />;

  return (
    <EggSlot>
      <EggImage alt={EGG_LABEL} onError={() => setFailed(true)} src={eggSpriteUrl(pluginId)} />
    </EggSlot>
  );
}

/**
 * One string, used by both branches.
 *
 * A constant rather than the literal written twice, because the two spellings
 * drifting apart is a silent failure: the panel would still render an egg, and
 * only a screen reader would hear the difference — after a poll, and only
 * sometimes.
 */
const EGG_LABEL = "An egg, not yet hatched";
