import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCEPTED_VIDEO_MIME_TYPES,
  DEFAULT_ESTIMATED_BYTES_PER_SECOND,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_MAX_VIDEO_SECONDS,
  DEFAULT_VIDEO_SIZE_WARN_BYTES,
  estimateTranscodedBytes,
  resolveVideoLimits,
} from '../src/videoLimits';
import { formatDuration, formatMegabytes } from '../src/formatMedia';

describe('resolveVideoLimits', () => {
  it('falls back to every documented default when given nothing', () => {
    expect(resolveVideoLimits()).toEqual({
      maxBytes: DEFAULT_MAX_VIDEO_BYTES,
      maxDurationSeconds: DEFAULT_MAX_VIDEO_SECONDS,
      sizeWarnBytes: DEFAULT_VIDEO_SIZE_WARN_BYTES,
      estimatedBytesPerSecond: DEFAULT_ESTIMATED_BYTES_PER_SECOND,
      acceptedMimeTypes: DEFAULT_ACCEPTED_VIDEO_MIME_TYPES,
    });
  });

  it('lets a consumer override one field without losing the others', () => {
    const resolved = resolveVideoLimits({ maxBytes: 50 });
    expect(resolved.maxBytes).toBe(50);
    expect(resolved.maxDurationSeconds).toBe(DEFAULT_MAX_VIDEO_SECONDS);
  });

  /**
   * `??`, not `||`. "Warn about everything" is a legitimate choice and
   * `||` would silently replace it with the 25 MB default — the kind of
   * quiet disagreement with the server these props exist to prevent.
   */
  it('honours an explicit 0 rather than treating it as absent', () => {
    expect(resolveVideoLimits({ sizeWarnBytes: 0 }).sizeWarnBytes).toBe(0);
    expect(resolveVideoLimits({ maxDurationSeconds: 0 }).maxDurationSeconds).toBe(0);
  });

  it('defaults to the four containers a phone actually produces', () => {
    // iPhone .mov is quicktime; Android gives mp4/webm; mkv is the
    // general-purpose container.
    expect([...DEFAULT_ACCEPTED_VIDEO_MIME_TYPES]).toEqual([
      'video/mp4',
      'video/quicktime',
      'video/x-matroska',
      'video/webm',
    ]);
  });
});

describe('estimateTranscodedBytes', () => {
  it('reproduces the measured default rate of ~6 MB per minute', () => {
    expect(formatMegabytes(estimateTranscodedBytes(60))).toBe('6 MB');
    expect(formatMegabytes(estimateTranscodedBytes(600))).toBe('60 MB');
  });

  it('uses a consumer-supplied rate instead of the default when given one', () => {
    expect(estimateTranscodedBytes(10, { estimatedBytesPerSecond: 1000 })).toBe(10_000);
  });
});

describe('formatDuration', () => {
  it('formats as m:ss with a zero-padded seconds field', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  /**
   * The origin project could stop at m:ss because its own duration cap
   * was 15 minutes. Here the cap is a prop, so an hour is reachable and
   * "75:30" would be the wrong answer rather than an unreachable one.
   */
  it('grows an h:mm:ss field past an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(4_530_000)).toBe('1:15:30');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-1_000)).toBe('0:00');
  });
});

describe('formatMegabytes', () => {
  it('rounds rather than truncating, so just-over-threshold does not read as exactly the threshold', () => {
    // 25.17 MB: truncating would print "25 MB" next to a warning that
    // says it is over 25 MB.
    expect(formatMegabytes(26_400_000)).toBe('25 MB');
    expect(formatMegabytes(25 * 1024 * 1024 + 1)).toBe('25 MB');
    expect(formatMegabytes(26 * 1024 * 1024)).toBe('26 MB');
  });
});
