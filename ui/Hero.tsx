import { type Activity, formatTokens, speciesLabel, spriteAlt, spriteUrl } from "./format.ts";
import { GrowthTrack, trackValueText } from "./GrowthTrack.tsx";
import {
  Chip,
  ChipRow,
  Dim,
  EggMark,
  Row,
  ShinyChip,
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
}: {
  view: CompanionView;
  activity: Activity;
  pluginId: string;
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
          An egg is drawn, never fetched. The sprite route parses its parameter
          as an integer, so `/sprite/egg` was a guaranteed 400 and a broken-image
          icon on every unhatched companion.
        */}
        {speciesId === null ? (
          <EggMark aria-label="An egg, not yet hatched" role="img" />
        ) : (
          <Sprite
            alt={spriteAlt(view.name, speciesId, active?.isShiny === true)}
            src={spriteUrl(pluginId, speciesId, active?.isShiny === true)}
          />
        )}

        <div>
          <h3>{speciesId === null ? "Egg" : speciesLabel(view.name, speciesId)}</h3>

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
                */}
                {active.dittoDisguise === null ? null : <Chip>?</Chip>}
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
              <Dim>
                {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} tokens incubated
              </Dim>
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
              <Dim>
                Stage {active.stageIndex + 1} of {active.plannedPath.length}
              </Dim>
              <Dim>
                {formatTokens(view.progress)} / {formatTokens(view.nextThreshold)} to the next stage
              </Dim>
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
