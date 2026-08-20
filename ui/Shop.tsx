import { formatTokens, shopLabel } from "./format.ts";
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
}: {
  offers: ReadonlyArray<{ entry: ShopEntry; price: number }>;
  wallet: number;
  onBuy: (entry: ShopEntry) => void;
  pending: boolean;
}) {
  return (
    <Row>
      {offers.map((offer) => (
        <Button
          disabled={wallet < offer.price || pending}
          key={`${offer.entry.kind}:${shopLabel(offer.entry)}`}
          onClick={() => onBuy(offer.entry)}
          type="button"
        >
          {shopLabel(offer.entry)} · <Numeric>{formatTokens(offer.price)}</Numeric>
        </Button>
      ))}
    </Row>
  );
}
