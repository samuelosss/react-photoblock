/**
 * The two formatters the default labels use for video metadata, exported
 * so a consumer overriding those labels can reuse them instead of
 * reimplementing them slightly differently.
 *
 * They are deliberately NOT locale-aware: every label in this package is
 * a function the consumer can replace outright (see src/labels.ts), so a
 * locale that wants `1,05` or a non-Latin digit set overrides the label
 * and formats however it likes. Baking `Intl` in here would add a
 * formatting opinion to a package whose whole point is not to have one.
 */

/**
 * Formats a duration in milliseconds as `m:ss` — e.g. `65_000` -> `"1:05"`.
 *
 * Grows an `h:mm:ss` branch past an hour rather than rendering `"75:30"`.
 * The origin project could skip that (its own cap was 15 minutes) but this
 * package's duration cap is a prop, so an hour-long clip is reachable here
 * and a four-digit minute count would be the wrong answer, not a
 * theoretical one.
 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Formats a byte count as whole megabytes — e.g. `26_400_000` -> `"25 MB"`.
 *
 * Rounds rather than truncates, so a file just barely over a warn
 * threshold does not display as exactly the threshold value and read as
 * "not actually over it".
 */
export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
