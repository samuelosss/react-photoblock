import type { VideoLimits } from './types';

/**
 * Defaults for the client-side video limits, and the one place that
 * resolves a partial `VideoLimits` into a complete set.
 *
 * WHY THESE ARE PROPS AND NOT CONSTANTS. In the origin project these three
 * numbers were hardcoded on the frontend with a comment admitting the
 * problem: the server read them from env vars, no endpoint exposed them,
 * and a deployment that overrode one would make the UI quietly disagree
 * with what the server would actually accept. This package cannot repeat
 * that, because it has no server at all to agree with — so the limits are
 * injected (`PhotoUploaderProps.videoLimits`) and these are only the
 * documented starting values.
 *
 * THE SERVER IS THE REAL ENFORCEMENT in every case. Everything here exists
 * to avoid pushing 300 MB up a phone uplink only to be rejected at the
 * other end, and to make the pre-upload estimate truthful.
 */

/** Hard ceiling on the SOURCE file size. */
export const DEFAULT_MAX_VIDEO_BYTES = 300 * 1024 * 1024;

/** Hard ceiling on SOURCE duration, in seconds. */
export const DEFAULT_MAX_VIDEO_SECONDS = 900;

/** Soft, informational threshold — warns, never blocks. */
export const DEFAULT_VIDEO_SIZE_WARN_BYTES = 25 * 1024 * 1024;

/**
 * The origin project's MEASURED transcode output rate: 6.0 MB per minute
 * of phone footage at its 720p web rendition. Expressed per second so the
 * estimate is a plain multiplication and a consumer can substitute its own
 * measurement without converting units.
 */
export const DEFAULT_ESTIMATED_BYTES_PER_SECOND = Math.round((6 * 1024 * 1024) / 60);

/**
 * Containers accepted client-side: iPhone `.mov` is `video/quicktime`,
 * Android gives `video/mp4` or `video/webm`, and `video/x-matroska` covers
 * `.mkv` as a general-purpose container.
 *
 * A browser's own `file.type` is a guess from the extension and can be an
 * empty string, so this filter only ever saves a round trip — it is not a
 * security boundary and must not be treated as one.
 */
export const DEFAULT_ACCEPTED_VIDEO_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
];

/** Every field present — what the component actually reads. */
export interface ResolvedVideoLimits {
  maxBytes: number;
  maxDurationSeconds: number;
  sizeWarnBytes: number;
  estimatedBytesPerSecond: number;
  acceptedMimeTypes: readonly string[];
}

/**
 * Fills a partial `VideoLimits` from the defaults above.
 *
 * Deliberately `??` and not `||`: a consumer passing `sizeWarnBytes: 0`
 * means "warn about everything", which is a legitimate (if noisy) choice,
 * and `||` would silently replace it with 25 MB.
 */
export function resolveVideoLimits(limits?: VideoLimits): ResolvedVideoLimits {
  return {
    maxBytes: limits?.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES,
    maxDurationSeconds: limits?.maxDurationSeconds ?? DEFAULT_MAX_VIDEO_SECONDS,
    sizeWarnBytes: limits?.sizeWarnBytes ?? DEFAULT_VIDEO_SIZE_WARN_BYTES,
    estimatedBytesPerSecond: limits?.estimatedBytesPerSecond ?? DEFAULT_ESTIMATED_BYTES_PER_SECOND,
    acceptedMimeTypes: limits?.acceptedMimeTypes ?? DEFAULT_ACCEPTED_VIDEO_MIME_TYPES,
  };
}

/**
 * Estimates the TRANSCODED size, in bytes, of a clip of the given source
 * duration — the number behind the before-upload warning.
 *
 * It is an estimate from one measured rate, not a prediction: a static
 * shot of a wall and a handheld pan of a crowd do not compress alike. That
 * is why the warning it drives is soft (an "upload anyway" button, never a
 * refusal) — being wrong by a factor of two must not be able to block a
 * legitimate upload.
 */
export function estimateTranscodedBytes(durationSeconds: number, limits?: VideoLimits): number {
  return durationSeconds * resolveVideoLimits(limits).estimatedBytesPerSecond;
}
