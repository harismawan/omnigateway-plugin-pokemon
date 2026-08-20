import { CONSUMABLE_ITEMS, itemLabel } from "./format.ts";
import { BagItem, Button, Dim, Row } from "./primitives.ts";

/**
 * What this key holds, and what can be done with it.
 *
 * The other half of a grant, and the reason the `use` route exists: a candy
 * earned at a rate-limit ceiling used to be a counter that only ever went up.
 */
export function Bag({
  inventory,
  onUse,
  pending,
}: {
  inventory: Record<string, number>;
  onUse: (item: string) => void;
  pending: boolean;
}) {
  // Zero-count entries are not held, so they are not shown — a bag listing
  // something it does not contain is the same lie in the other direction.
  // `freshState` writes every item at zero, so an unfiltered bag would list the
  // whole catalogue as if it were owned.
  const held = Object.entries(inventory).filter(([, count]) => count > 0);

  if (held.length === 0) return <Dim>Nothing in the bag.</Dim>;

  return (
    <Row>
      {held.map(([item, count]) => (
        <BagItem key={item}>
          {/*
            One text node, not a name beside a styled count. The count here is a
            single digit read on its own rather than a figure lined up against
            another one, so the mono treatment the prices get would buy nothing
            and would split the label an operator reads as one phrase.
          */}
          <span>{`${itemLabel(item)} · ${count}`}</span>
          {CONSUMABLE_ITEMS.includes(item) ? (
            <Button disabled={pending} onClick={() => onUse(item)} type="button">
              Use {itemLabel(item)}
            </Button>
          ) : (
            // No button, and not a disabled one either: a disabled button says
            // "not right now", and this is never spendable at all.
            <Dim>held</Dim>
          )}
        </BagItem>
      ))}
    </Row>
  );
}
