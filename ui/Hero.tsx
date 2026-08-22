import { EggSprite } from "./EggSprite.tsx";
import { type Activity, formatTokens, spriteAlt, spriteUrl } from "./format.ts";
import { GrowthTrack, trackValueText } from "./GrowthTrack.tsx";
import {
  Button,
  Chip,
  ChipRow,
  Fact,
  HeroName,
  Row,
  ShinyChip,
  SpeciesNumber,
  Sprite,
  Stat,
  StatLabel,
  Stats,
  StatValue,
} from "./primitives.ts";
import type { CompanionView } from "./types.ts";

/**
 * The companion itself: what it is, how it is doing, and how far it has come.
 *
 * The heading is the species name because that is what an operator recognises,
 * and everything the name cannot carry — rarity, shininess, nature, the egg's
 * guaranteed tier — sits beside it as a chip. That ordering is the point: one
 * thing to read first, then the qualifiers, then the numbers.
 */
export function Hero({
  view,
  activity,
  pluginId,
  onRelease,
  releasing,
}: {
  view: CompanionView;
  activity: Activity;
  pluginId: string;
  onRelease: () => void;
  releasing: boolean;
}) {
  // Narrowed by the caller, which has already handled the unreadable save. A
  // hero with no state is not a state this component can draw.
  const state = view.state;
  if (state === null) return null;
  const { active } = state;
  const speciesId = active === null ? null : (active.plannedPath[active.stageIndex] ?? null);

  return (
    <>
      <Row>
        {/*
          Fetched now, through the *item* sprite route rather than the species
          one. The distinction is the whole reason this is possible: the species
          route parses its parameter as an integer, so `/sprite/egg` was a
          guaranteed 400 and a broken-image icon on every unhatched companion —
          whereas the item route looks its parameter up in a closed map, which
          now has an entry for an incubating companion. `EggSprite` still falls
          back to the drawn mark, so the 400 that used to be certain is now an
          egg either way.
        */}
        {speciesId === null ? (
          <EggSprite pluginId={pluginId} />
        ) : (
          <Sprite
            alt={spriteAlt(view.name, speciesId, active?.isShiny === true)}
            src={spriteUrl(pluginId, speciesId, active?.isShiny === true)}
          />
        )}

        <div>
          {/*
            The number in front of the name, the way a Pokédex prints one — and
            the same two-slot rule the Dex grid follows, for the same reason.
            `speciesLabel` fills one slot with whichever of name-or-number
            exists; here there are two, so it would render `#25 #25` on a
            species the cache has not resolved yet. Number always, name only
            when there is one.

            An egg gets neither. Its species is not rolled until it hatches, so
            a number beside "Egg" would be the panel inventing a fact the save
            does not hold — and a `#` with nothing after it would be worse.
          */}
          <HeroName>
            {speciesId === null ? (
              "Egg"
            ) : (
              <>
                <SpeciesNumber>#{speciesId}</SpeciesNumber>
                {view.name === null ? null : <span>{view.name}</span>}
              </>
            )}
          </HeroName>

          <ChipRow>
            {active === null ? (
              state.eggTier === null ? null : (
                <Chip>{state.eggTier}+ guaranteed</Chip>
              )
            ) : (
              <>
                <Chip>{active.rarity}</Chip>
                {active.isShiny ? (
                  <ShinyChip>
                    {/* Hidden from the accessible name: a screen reader
                        announcing "black four pointed star shiny" is worse than
                        one announcing "shiny", and the word is what carries the
                        fact either way. */}
                    <span aria-hidden="true">✦</span>shiny
                  </ShinyChip>
                ) : null}
                <Chip>{active.nature}</Chip>
                {/*
                  A Ditto in disguise is a secret the panel is allowed to hint
                  at and not to spoil, which is the whole joke: the question
                  mark says something is off about this one.

                  It stops once the disguise drops. `dittoDisguise` stays set
                  after a reveal — it records what this one was pretending to
                  be, which the Dex still wants — so the hint is keyed on
                  `dittoRevealed` rather than on the disguise being present. Left
                  on the first field it would mark a revealed Ditto as still
                  hiding something, forever.
                */}
                {active.dittoDisguise === null || active.dittoRevealed ? null : <Chip>?</Chip>}
                {/*
                  What the companion is holding, named rather than described.
                  "everstone" says the same thing to somebody who knows the item
                  and sends everybody else to the shop row, where the price sits
                  next to the explanation — whereas "pinned" or "+25%" would be
                  this panel inventing vocabulary for a thing that already has a
                  name.
                */}
                {active.everstone ? <Chip>everstone</Chip> : null}
                {active.soothe ? <Chip>soothe bell</Chip> : null}
              </>
            )}
            {/*
              Text, not a tint. The console's rule is that colour means provider
              identity or state, and even where a state may be coloured it may
              not be the *only* way the state is legible.
            */}
            <Chip aria-label={`Activity: ${activity}`} role="status">
              {activity}
            </Chip>
          </ChipRow>

          {active === null ? (
            <>
              <GrowthTrack
                label="Incubation"
                progress={view.progress}
                stageIndex={0}
                stages={1}
                threshold={view.nextThreshold}
                valueText={`${formatTokens(view.progress)} of ${formatTokens(view.nextThreshold)} tokens incubated`}
              />
              <Fact>
                {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} tokens incubated
              </Fact>
            </>
          ) : (
            <>
              <GrowthTrack
                label="Growth to the next evolution"
                progress={view.progress}
                stageIndex={active.stageIndex}
                stages={active.plannedPath.length}
                threshold={view.nextThreshold}
                valueText={trackValueText(
                  active.plannedPath.length,
                  active.stageIndex,
                  view.progress,
                  view.nextThreshold,
                )}
              />
              <Fact>
                Stage {active.stageIndex + 1} of {active.plannedPath.length}
              </Fact>
              {active.everstone ? (
                <>
                  {/*
                    A pinned companion's progress runs past its threshold and
                    keeps going, so the usual "X / Y to the next stage" would
                    read as a number stuck above the line it should already have
                    crossed — which is exactly how a stuck state gets mistaken
                    for a broken one. Banked is what it is, so banked is what it
                    says.
                  */}
                  <Fact>Held at this stage · {formatTokens(view.progress)} banked</Fact>
                  <Button disabled={releasing} onClick={onRelease} type="button">
                    Release
                  </Button>
                </>
              ) : (
                <Fact>
                  {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} to the next
                  stage
                </Fact>
              )}
            </>
          )}
        </div>
      </Row>

      {/*
        Three numbers an operator reads separately: what this key has earned in
        its lifetime, what is left to spend, and how many companions it has seen
        all the way through. Run together in a sentence they read as one fact
        about tokens, which is how "earned" and "to spend" got confused for each
        other in the first place.
      */}
      <Stats>
        <Stat>
          <StatLabel>Earned</StatLabel>
          <StatValue>{formatTokens(view.tokensTotal)}</StatValue>
        </Stat>
        <Stat>
          <StatLabel>To spend</StatLabel>
          <StatValue>{formatTokens(view.wallet)}</StatValue>
        </Stat>
        <Stat>
          <StatLabel>Graduated</StatLabel>
          <StatValue>{view.dex.length.toLocaleString()}</StatValue>
        </Stat>
      </Stats>
    </>
  );
}
