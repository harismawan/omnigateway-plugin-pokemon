import { CONSUMABLE_ITEMS, formatTokens, shopLabel } from "./format.ts";
import { Button, Numeric, Row } from "./primitives.ts";
import type { ShopEntry } from "./types.ts";

/**
 * What the wallet buys.
 *
 * An offer beyond the balance is disabled rather than hidden: a shop that
 * showed only what an operator could afford would give a key with an empty
 * wallet an empty shop, and the prices are the thing worth saving up against.
 */
export function Shop({
  offers,
  wallet,
  onBuy,
  pending,
  inventory,
}: {
  offers: ReadonlyArray<{ entry: ShopEntry; price: number }>;
  wallet: number;
  onBuy: (entry: ShopEntry) => void;
  pending: boolean;
  /** What is already held, for the entries that can only be owned once. */
  inventory: Record<string, number>;
}) {
  return (
    <Row>
      {offers.map((offer) => {
        const owned = alreadyOwned(offer.entry, inventory);
        return (
          <Button
            disabled={owned || wallet < offer.price || pending}
            key={`${offer.entry.kind}:${shopLabel(offer.entry)}`}
            onClick={() => onBuy(offer.entry)}
            type="button"
          >
            {/*
              "owned" replaces the price rather than sitting beside it. A price
              on a thing that cannot be bought is the one number here that means
              nothing, and it is the number the eye goes to.
            */}
            {shopLabel(offer.entry)} ·{" "}
            {owned ? "owned" : <Numeric>{formatTokens(offer.price)}</Numeric>}
          </Button>
        );
      })}
    </Row>
  );
}

/**
 * Whether this entry is a passive the key already holds.
 *
 * Passive means "cannot be spent", which is the same as "not in
 * `CONSUMABLE_ITEMS`" — so this reuses the allowlist the bag already mirrors
 * rather than naming the shiny charm a second time.
 *
 * The server refuses the purchase regardless; this only keeps the panel from
 * offering a button that is a guaranteed 409, on the same terms as the bag not
 * offering a "use" for a passive.
 */
function alreadyOwned(entry: ShopEntry, inventory: Record<string, number>): boolean {
  if (entry.kind !== "item") return false;
  return !CONSUMABLE_ITEMS.includes(entry.item) && (inventory[entry.item] ?? 0) > 0;
}
