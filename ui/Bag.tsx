import { itemCard } from "./catalog.ts";
import { itemLabel } from "./format.ts";
import { ItemIcon } from "./ItemIcon.tsx";
import {
  Button,
  Dim,
  ItemAction,
  ItemBlurb,
  ItemCard,
  ItemGrid,
  ItemHead,
  ItemName,
  Numeric,
} from "./primitives.ts";

/**
 * What this key holds, and what can be done with it.
 *
 * The other half of a grant, and the reason the `use` route exists: a candy
 * earned at a rate-limit ceiling used to be a counter that only ever went up.
 *
 * The same card and the same grid as the shop, deliberately. These are one kind
 * of thing seen twice — an item, named, pictured and described — and the only
 * differences are the number in the corner and the verb on the button.
 */
export function Bag({
  inventory,
  onUse,
  pending,
  pluginId,
}: {
  inventory: Record<string, number>;
  onUse: (item: string) => void;
  pending: boolean;
  pluginId: string;
}) {
  // Zero-count entries are not held, so they are not shown — a bag listing
  // something it does not contain is the same lie in the other direction.
  // `freshState` writes every item at zero, so an unfiltered bag would list the
  // whole catalogue as if it were owned.
  const held = Object.entries(inventory).filter(([, count]) => count > 0);

  if (held.length === 0) return <Dim>Nothing in the bag.</Dim>;

  return (
    <ItemGrid>
      {held.map(([item, count]) => {
        const card = itemCard(item);
        return (
          <ItemCard key={item}>
            <ItemHead>
              <ItemIcon emoji={card.emoji} item={item} pluginId={pluginId} />
              <ItemName>{itemLabel(item)}</ItemName>
              {/*
                Where the shop puts a price. A count and a price are read the
                same way — one number in the corner of a card — so they get the
                same treatment and the same slot, and the shop and the bag stay
                one layout rather than two that resemble each other.
              */}
              <Numeric>×{count}</Numeric>
            </ItemHead>

            <ItemBlurb>{card.blurb}</ItemBlurb>

            <ItemAction>
              {card.consumable ? (
                <Button disabled={pending} onClick={() => onUse(item)} type="button">
                  Use {itemLabel(item)}
                </Button>
              ) : (
                // No button, and not a disabled one either: a disabled button
                // says "not right now", and this is never spendable at all.
                <Dim>held</Dim>
              )}
            </ItemAction>
          </ItemCard>
        );
      })}
    </ItemGrid>
  );
}
