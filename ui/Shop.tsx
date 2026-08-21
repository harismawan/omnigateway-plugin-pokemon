import { EGG_EMOJI, eggBlurb, itemCard } from "./catalog.ts";
import { formatTokens, itemLabel, shopLabel } from "./format.ts";
import { ItemIcon } from "./ItemIcon.tsx";
import {
  Button,
  Chip,
  Dim,
  ItemAction,
  ItemBlurb,
  ItemCard,
  ItemGrid,
  ItemHead,
  ItemName,
  Numeric,
} from "./primitives.ts";
import type { ShopEntry } from "./types.ts";

/**
 * What the wallet buys.
 *
 * An offer beyond the balance is disabled rather than hidden: a shop that
 * showed only what an operator could afford would give a key with an empty
 * wallet an empty shop, and the prices are the thing worth saving up against.
 *
 * A grid of cards rather than the row of buttons this used to be. The row said
 * `rare candy · 500.0M` and nothing else, so the shop was legible only to
 * somebody who already knew the economy — which was everybody who wrote it and
 * nobody who inherited it. What the extra room buys is the sentence.
 */
export function Shop({
  offers,
  wallet,
  onBuy,
  pending,
  inventory,
  hasCompanion,
  pluginId,
}: {
  offers: ReadonlyArray<{ entry: ShopEntry; price: number }>;
  wallet: number;
  onBuy: (entry: ShopEntry) => void;
  pending: boolean;
  /** What is already held, for the entries that can only be owned once. */
  inventory: Record<string, number>;
  /** False while an egg is incubating, when there is nothing an egg could replace. */
  hasCompanion: boolean;
  pluginId: string;
}) {
  return (
    <ItemGrid>
      {offers.map((offer) => {
        const { entry, price } = offer;
        const owned = alreadyOwned(entry, inventory);
        // An egg is a reroll, so with nothing to reroll there is nothing to
        // sell — and the server refuses it. Disabled rather than hidden, like
        // an offer beyond the wallet: the prices are what an operator saves up
        // against, and a shop that reshuffles as the egg grows is harder to
        // read than one that greys a row out.
        const nothingToReplace = entry.kind === "egg" && !hasCompanion;
        const label = entry.kind === "item" ? itemLabel(entry.item) : "fresh egg";

        return (
          <ItemCard key={entry.kind === "item" ? `item:${entry.item}` : `egg:${entry.tier ?? ""}`}>
            <ItemHead>
              <ItemIcon
                emoji={entry.kind === "item" ? itemCard(entry.item).emoji : EGG_EMOJI}
                // `egg` is the sprite map's own key for every tier: the
                // guarantee is a fact about this offer, not about the artwork,
                // so it is carried by the chip below rather than by the icon.
                item={entry.kind === "item" ? entry.item : "egg"}
                pluginId={pluginId}
              />
              <ItemName>{label}</ItemName>
              {/*
                "owned" replaces the price rather than sitting beside it. A price
                on a thing that cannot be bought is the one number here that means
                nothing, and it is the number the eye goes to.
              */}
              {owned ? <Dim>owned</Dim> : <Numeric>{formatTokens(price)}</Numeric>}
            </ItemHead>

            {entry.kind === "egg" && entry.tier !== null ? <Chip>{entry.tier}+</Chip> : null}

            <ItemBlurb>
              {entry.kind === "item" ? itemCard(entry.item).blurb : eggBlurb(entry.tier)}
            </ItemBlurb>

            <ItemAction>
              {/*
                `shopLabel` and not the heading's `label`, because three egg
                tiers share one heading and the chip beside it is what tells
                them apart. A chip is not part of a button's accessible name, so
                naming this button "Buy fresh egg" three times would leave a
                screen reader with three identical controls that do different
                things — and one of them spends 4B.
              */}
              <Button
                disabled={owned || nothingToReplace || wallet < price || pending}
                onClick={() => onBuy(entry)}
                type="button"
              >
                Buy {shopLabel(entry)}
              </Button>
            </ItemAction>
          </ItemCard>
        );
      })}
    </ItemGrid>
  );
}

/**
 * Whether this entry is a passive the key already holds.
 *
 * Passive means "cannot be spent", and the flag for that is the one on the
 * item's own card — the same field the bag reads to decide whether to offer a
 * "use". Naming the shiny charm a second time here would be a second
 * derivation; so, it turns out, was asking `CONSUMABLE_ITEMS`.
 *
 * **That was the first version and it was wrong**, in the one case the
 * catalogue's fallback exists for. `CONSUMABLE_ITEMS` is built from the ids the
 * catalogue knows, so an item it has never heard of is absent from it and was
 * read here as passive — while `itemCard` deliberately calls the same item
 * spendable, and the bag agreed. A stackable item the server shipped before
 * anybody wrote its copy would have been usable from the bag and permanently
 * unbuyable from the shop after one purchase, its price replaced by the word
 * "owned". One flag, read the same way on both surfaces.
 *
 * The server refuses the purchase regardless; this only keeps the panel from
 * offering a button that is a guaranteed 409.
 */
function alreadyOwned(entry: ShopEntry, inventory: Record<string, number>): boolean {
  if (entry.kind !== "item") return false;
  return !itemCard(entry.item).consumable && (inventory[entry.item] ?? 0) > 0;
}
