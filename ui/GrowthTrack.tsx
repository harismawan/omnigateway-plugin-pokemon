import { formatTokens } from "./format.ts";
import { Segment, SegmentFill, Track } from "./primitives.ts";

/**
 * The evolution line as a stepped bar.
 *
 * One `progressbar` rather than one per segment: the segments are how the line
 * is *drawn*, and a screen reader announcing three separate progress bars would
 * be describing the drawing instead of the fact. `aria-valuetext` carries the
 * part the raw numbers cannot — which stage of how many — so the announcement
 * matches what the eye is being told, rather than a bare percentage.
 */
export function GrowthTrack({
  stages,
  stageIndex,
  progress,
  threshold,
  label,
  valueText,
}: {
  /** How many segments the line has. One, for an egg with no line yet. */
  stages: number;
  stageIndex: number;
  progress: number;
  threshold: number;
  label: string;
  valueText: string;
}) {
  // Guarded rather than trusted: `threshold` arrives from the server and a zero
  // would divide the meter by nothing. A save whose threshold is missing should
  // draw an empty bar, not `NaN%`.
  const pct = (progress / Math.max(1, threshold)) * 100;

  return (
    <Track
      aria-label={label}
      aria-valuemax={threshold}
      aria-valuemin={0}
      aria-valuenow={progress}
      aria-valuetext={valueText}
      role="progressbar"
    >
      {Array.from({ length: Math.max(1, stages) }, (_unused, stage) => (
        <Segment
          // The index is the identity here, unusually and correctly: a segment
          // *is* its position in the line, and the line only changes length when
          // the companion is replaced outright.
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its index
          key={stage}
        >
          {/* Behind the current stage is done, ahead of it has not started, and
              the current one carries the real number. */}
          {stage < stageIndex ? <SegmentFill $pct={100} /> : null}
          {stage === stageIndex ? <SegmentFill $pct={pct} /> : null}
        </Segment>
      ))}
    </Track>
  );
}

/** How far into the whole line, said the way the panel says it out loud. */
export function trackValueText(
  stages: number,
  stageIndex: number,
  progress: number,
  threshold: number,
): string {
  return `stage ${stageIndex + 1} of ${stages}, ${formatTokens(progress)} of ${formatTokens(threshold)} tokens`;
}
