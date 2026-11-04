import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFile } from './base64ToFile';
import type { GooglePhotosAdapter, GooglePhotosVideoImportError, VideoItem } from '../types';
import type { GooglePhotosLabels, GooglePhotosVideoErrorLabels } from '../labels';

export type GooglePhotosPickerPhase = 'idle' | 'connecting' | 'picking' | 'importing' | 'error';

/** Every code this hook can report. The four backend-defined codes pass
 *  straight through from the adapter's bridge-poll result; the other
 *  three are local synthetic codes for failures this hook detects itself
 *  (a thrown exception, a blocked popup, an expired/timed-out wait). */
export type GooglePhotosErrorCode =
  | 'googleNotConfigured'
  | 'invalidState'
  | 'missingCode'
  | 'oauthFailed'
  | 'pickerSessionFailed'
  | 'sessionExpired'
  | 'bridgeTimeout'
  | 'popupBlocked'
  | 'videoNeedsSavedParent'
  | 'startFailed'
  | 'pollFailed'
  | 'importFailed'
  | 'generic';

export interface GooglePhotosPickerError {
  code: GooglePhotosErrorCode;
  /** The underlying Error's message, when this came from a thrown
   *  exception rather than a known backend error code. Some label
   *  functions (startFailed/pollFailed/importFailed) use it; the rest
   *  ignore it. */
  detail?: string;
}

/** Maps the adapter's raw backend error strings to this hook's own fixed
 *  code union. Anything not in this table (a future backend error code
 *  this hook doesn't know about yet) becomes 'generic' rather than
 *  crashing or showing nothing — see resolveGooglePhotosErrorMessage. */
const BACKEND_ERROR_CODE_MAP: Record<string, GooglePhotosErrorCode> = {
  google_not_configured: 'googleNotConfigured',
  invalid_state: 'invalidState',
  missing_code: 'missingCode',
  oauth_failed: 'oauthFailed',
  picker_session_failed: 'pickerSessionFailed',
};

/** Resolves a GooglePhotosPickerError into display text using the given
 *  labels. Exported so a consumer building a fully custom UI around this
 *  hook (rather than using MediaUploader's built-in button) doesn't have
 *  to reimplement this switch. */
export function resolveGooglePhotosErrorMessage(error: GooglePhotosPickerError, labels: GooglePhotosLabels): string {
  switch (error.code) {
    case 'startFailed':
      return labels.errors.startFailed(error.detail);
    case 'pollFailed':
      return labels.errors.pollFailed(error.detail);
    case 'importFailed':
      return labels.errors.importFailed(error.detail);
    case 'googleNotConfigured':
      return labels.errors.googleNotConfigured;
    case 'invalidState':
      return labels.errors.invalidState;
    case 'missingCode':
      return labels.errors.missingCode;
    case 'oauthFailed':
      return labels.errors.oauthFailed;
    case 'pickerSessionFailed':
      return labels.errors.pickerSessionFailed;
    case 'sessionExpired':
      return labels.errors.sessionExpired;
    case 'bridgeTimeout':
      return labels.errors.bridgeTimeout;
    case 'popupBlocked':
      return labels.errors.popupBlocked;
    case 'videoNeedsSavedParent':
      return labels.errors.videoNeedsSavedParent;
    default:
      return labels.errors.generic;
  }
}

/**
 * The per-item video import failure codes this package knows, as ONE
 * array mapped to label keys.
 *
 * Kept as one table (not a hand-duplicated union plus a separate lookup)
 * so the type, the mapping and this module's own test all walk the same
 * list — a new code is added here once. A second, drifting list is a bug
 * shape the origin project shipped more than once.
 *
 * `video_needs_saved_parent` is deliberately NOT here: it rejects the
 * whole import as a thrown error (see `GooglePhotosErrorCode`), never as
 * one of these per-item entries.
 */
export const GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS: Record<string, keyof GooglePhotosVideoErrorLabels> = {
  video_not_ready: 'videoNotReady',
  video_too_large: 'videoTooLarge',
  video_download_failed: 'videoDownloadFailed',
  video_processing_failed: 'videoProcessingFailed',
  video_too_long: 'videoTooLong',
  video_queue_full: 'videoQueueFull',
};

/**
 * Renders one `videoErrors` entry for display.
 *
 * Falls back to the backend's own `message` ONLY when `code` is missing
 * or is not one of the codes above — the honest escape hatch for a
 * backend addition this package has not met yet, never a substitute for
 * adding it to the table. Exported for the same reason
 * `resolveGooglePhotosErrorMessage` is: a consumer building its own UI
 * around the hook should not have to reimplement this.
 */
export function resolveGooglePhotosVideoErrorMessage(
  entry: GooglePhotosVideoImportError,
  labels: GooglePhotosLabels,
): string {
  const labelKey = entry.code ? GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS[entry.code] : undefined;
  return labels.videoErrorLine(entry.fileName, labelKey ? labels.videoErrors[labelKey] : entry.message);
}

// Fixed client-side pacing for the by-state bridge poll — the adapter
// doesn't hand back an adaptive interval for this one (unlike the picker-
// session poll below, whose interval the adapter itself controls), so a
// plain fixed interval/timeout is enough. 10 minutes gives a user who
// reads the consent screen carefully, or picks the wrong account and
// starts over inside the popup, room to actually finish — with an
// explicit `cancel()` available for genuinely giving up.
const BRIDGE_POLL_INTERVAL_MS = 1500;
const BRIDGE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export interface UseGooglePhotosPickerOptions {
  /**
   * The four functions that make this feature work — see
   * `GooglePhotosAdapter` in src/types.ts and docs/google-photos-setup.md.
   * Omit this (or pass `undefined`) to disable the feature entirely: the
   * hook then does nothing at all — no timers, no listeners, `start()`/
   * `cancel()` are no-ops, and `enabled` is `false`. MediaUploader uses
   * that flag to skip rendering the picker button altogether, so a
   * consumer with no Google configuration gets no dead control and no
   * console warning, by construction.
   */
  adapter?: GooglePhotosAdapter;
  /** Handed the imported photos as real Files, already converted
   *  server-side per your adapter's own pipeline — feed these into
   *  whatever upload queue you'd feed a locally-picked file. Safe to
   *  pass a new closure on every render; the hook keeps only the latest
   *  one, via an internal ref, so it is never a reason to re-run an
   *  effect. */
  onPhotosReady: (files: File[]) => void;
  /**
   * The owning entity's id, `null` before its first save.
   *
   * Read FRESH at the moment of import via a ref, not captured in a
   * dependency array: this value typically goes `null` -> a real id
   * exactly once per form, and an import must never run against a stale
   * id just because a re-render lagged behind. It is also deliberately
   * NOT a dependency — making it one would churn the poll loop's identity
   * on every unrelated re-render (a progress tick, say), and a one-time
   * server result landing in that recreation gap would be silently
   * dropped.
   *
   * A picked PHOTO never needs it. A picked VIDEO does — see
   * `GooglePhotosAdapter.importGooglePhotosSession`.
   */
  entityId?: string | null;
  /**
   * Handed the imported videos (each already a real, server-created
   * 'processing' row) plus any per-item import failures. Optional: a
   * consumer with no video support simply never passes it, exactly like
   * the `video` prop elsewhere in this package. Same stable-identity
   * treatment as `onPhotosReady`. */
  onVideosReady?: (videos: VideoItem[], errors: GooglePhotosVideoImportError[]) => void;
}

/** How many items one import actually landed, and how many videos it
 *  could not. All three can be non-zero at once, which is why this is a
 *  shape and not a number. */
export interface GooglePhotosImportCounts {
  photos: number;
  videos: number;
  failedVideos: number;
}

export interface UseGooglePhotosPickerResult {
  /** False when no adapter was supplied — the whole feature is off. */
  enabled: boolean;
  phase: GooglePhotosPickerPhase;
  error: GooglePhotosPickerError | null;
  /** Set after a successful import, to what it landed — the consumer
   *  decides how to phrase that (see
   *  `labels.googlePhotos.importedNotice`). Cleared when a new run
   *  starts. Not cleared automatically otherwise: once the popup has
   *  navigated through the OAuth provider's own pages this tab usually
   *  can no longer close it (see docs/google-photos-setup.md), so this
   *  is the one persistent signal that the import actually finished. */
  imported: GooglePhotosImportCounts | null;
  start: () => void;
  /** Explicit "give up": stops polling, closes the popup if still
   *  reachable, and returns to idle. */
  cancel: () => void;
  dismissError: () => void;
}

/**
 * Drives the "pick from Google Photos" popup flow end to end: opens a
 * popup at the adapter-provided URL, polls `pollGooglePhotosBridge` (with
 * the `state` the same start call returned) until the popup's OAuth round
 * trip resolves, then polls `pollGooglePhotosSession` until the user
 * finishes picking, imports the result, and converts it to real Files for
 * the caller. One flow at a time — `start()` is a no-op unless the
 * current phase is 'idle' or 'error'.
 *
 * Deliberately plain same-origin polling by an opaque `state` value, not
 * any form of cross-window messaging. Two other mechanisms were tried in
 * the project this was extracted from, and both failed in real testing:
 * `window.opener.postMessage` (severed by Cross-Origin-Opener-Policy once
 * the popup round-trips through the OAuth provider's own consent screen)
 * and then `BroadcastChannel` (doesn't depend on `window.opener`, but
 * still never delivered reliably in practice — a browser privacy feature
 * partitioning it across that same cross-origin round trip was the likely
 * cause). Polling by `state` needs nothing from the popup at all: this
 * tab already knows `state` from the adapter's own `start` response,
 * before the popup even opens, and talks to the same-origin backend the
 * entire time — exactly like every other request the app already makes,
 * immune to whatever a browser does with cross-window APIs. See
 * docs/google-photos-setup.md for the full write-up of these failure
 * modes and why the "bridge" step (a server-side landing page with a
 * `state` parameter) exists at all.
 */
export function useGooglePhotosPicker({
  adapter,
  onPhotosReady,
  entityId,
  onVideosReady,
}: UseGooglePhotosPickerOptions): UseGooglePhotosPickerResult {
  const [phase, setPhase] = useState<GooglePhotosPickerPhase>('idle');
  const [error, setError] = useState<GooglePhotosPickerError | null>(null);
  const [imported, setImported] = useState<GooglePhotosImportCounts | null>(null);

  const popupRef = useRef<Window | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  // Keeps the latest onPhotosReady without making it a dependency of any
  // effect below — a fresh closure every render must never tear down and
  // recreate the poll loop or a one-time server broadcast could land in
  // the recreation gap and be silently dropped.
  const onPhotosReadyRef = useRef(onPhotosReady);
  useEffect(() => {
    onPhotosReadyRef.current = onPhotosReady;
  });

  // onVideosReady gets the same treatment, for the same reason.
  const onVideosReadyRef = useRef(onVideosReady);
  useEffect(() => {
    onVideosReadyRef.current = onVideosReady;
  });

  // See `entityId`'s own doc: a ref updated every render, deliberately
  // not a dependency.
  const entityIdRef = useRef(entityId);
  useEffect(() => {
    entityIdRef.current = entityId;
  });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const fail = useCallback((code: GooglePhotosErrorCode, detail?: string) => {
    if (!aliveRef.current) return;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    setPhase('error');
    setError({ code, detail });
  }, []);

  const resetToIdle = useCallback(() => {
    if (!aliveRef.current) return;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    setPhase('idle');
    setError(null);
  }, []);

  // Both recursive poll loops below are held in refs rather than
  // referencing their own useCallback binding directly from within their
  // own body — a recursive self-reference there reads the `const` while
  // it's still being initialized (a temporal-dead-zone read), which works
  // in practice (the recursive call only ever fires later, from inside an
  // async setTimeout callback) but is fragile enough to avoid outright.
  const scheduleSessionPollRef = useRef<(sessionId: string, delayMs: number, deadline: number) => void>(() => {});

  const scheduleSessionPoll = useCallback(
    (sessionId: string, delayMs: number, deadline: number) => {
      pollTimeoutRef.current = setTimeout(() => {
        void (async () => {
          if (!aliveRef.current || !adapter) return;

          // Deliberately does NOT check popupRef.current.closed — see the
          // comment on the bridge poll below; the same unreliability
          // applies here.
          if (Date.now() > deadline) {
            fail('sessionExpired');
            return;
          }

          try {
            const res = await adapter.pollGooglePhotosSession(sessionId);
            if (!aliveRef.current) return;
            if (res.expired) {
              fail('sessionExpired');
              return;
            }
            if (res.done) {
              setPhase('importing');
              try {
                const {
                  photos,
                  videos = [],
                  videoErrors = [],
                  // `entityIdRef`, not a captured value — see `entityId`'s
                  // own doc. An adapter that ignores the argument (a
                  // photo-only consumer) is unaffected.
                } = await adapter.importGooglePhotosSession(sessionId, entityIdRef.current ?? null);
                if (!aliveRef.current) return;
                // Best-effort: works only if this tab still has a live
                // handle on the popup, which by this point it usually
                // does NOT — see `imported`'s own doc above.
                try {
                  popupRef.current?.close();
                } catch {
                  // Severed popup — not closable from here.
                }
                onPhotosReadyRef.current(photos.map((p) => base64ToFile(p.fileName, p.contentType, p.dataBase64)));
                // Videos arrive as server rows, not bytes — the consumer
                // merges them into its own `videos` state and the status
                // poll takes them from 'processing' to 'ready'.
                onVideosReadyRef.current?.(videos, videoErrors);
                resetToIdle();
                setImported({ photos: photos.length, videos: videos.length, failedVideos: videoErrors.length });
              } catch (err) {
                // The ONE import-time failure that rejects the whole
                // import rather than landing in a per-item `videoErrors`
                // entry: a video was picked with no saved parent to
                // attach it to. Reported by its own code so a consumer
                // can tell the user to save first, instead of showing
                // the generic "importing failed".
                const code =
                  err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
                if (code === 'video_needs_saved_parent') {
                  fail('videoNeedsSavedParent');
                  return;
                }
                fail('importFailed', err instanceof Error ? err.message : undefined);
              }
              return;
            }
            scheduleSessionPollRef.current(sessionId, res.pollIntervalMs, deadline);
          } catch (err) {
            fail('pollFailed', err instanceof Error ? err.message : undefined);
          }
        })();
      }, delayMs);
    },
    [adapter, fail, resetToIdle],
  );

  useEffect(() => {
    scheduleSessionPollRef.current = scheduleSessionPoll;
  }, [scheduleSessionPoll]);

  const scheduleBridgePollRef = useRef<(state: string, delayMs: number, deadline: number) => void>(() => {});

  const scheduleBridgePoll = useCallback(
    (state: string, delayMs: number, deadline: number) => {
      pollTimeoutRef.current = setTimeout(() => {
        void (async () => {
          if (!aliveRef.current || !adapter) return;

          // Deliberately does NOT check popupRef.current.closed. That
          // looks like the obvious way to notice "the user gave up", but
          // it is not trustworthy here: once a popup is severed from its
          // opener (Cross-Origin-Opener-Policy on the OAuth provider's own
          // pages, or a browser privacy feature), `closed` can report
          // `true` while the window is still visibly open and the user is
          // still working in it. Acting on that false positive silently
          // resets this flow to idle with no error shown at all —
          // indistinguishable from "nothing happened", which is exactly
          // what a stuck picker looks like. The server-side result plus
          // the deadline below are authoritative instead, and `cancel()`
          // is there for a genuine give-up. See docs/google-photos-setup.md.
          if (Date.now() > deadline) {
            fail('bridgeTimeout');
            return;
          }

          try {
            const res = await adapter.pollGooglePhotosBridge(state);
            if (!aliveRef.current) return;

            if (!res.ready) {
              scheduleBridgePollRef.current(state, BRIDGE_POLL_INTERVAL_MS, deadline);
              return;
            }
            if (res.error) {
              if (res.error === 'oauth_denied') {
                // The user clicked Cancel on the OAuth provider's own
                // consent screen — a normal change of mind, not an error.
                resetToIdle();
                return;
              }
              fail(BACKEND_ERROR_CODE_MAP[res.error] ?? 'generic');
              return;
            }
            // ready with neither an error nor a sessionId would be an
            // adapter contract violation — treat it the same as "keep
            // waiting" rather than crashing on a missing sessionId below.
            if (!res.sessionId) {
              scheduleBridgePollRef.current(state, BRIDGE_POLL_INTERVAL_MS, deadline);
              return;
            }

            setPhase('picking');
            scheduleSessionPoll(res.sessionId, res.pollIntervalMs ?? 2000, Date.now() + (res.timeoutMs ?? 30 * 60 * 1000));
          } catch (err) {
            fail('pollFailed', err instanceof Error ? err.message : undefined);
          }
        })();
      }, delayMs);
    },
    [adapter, scheduleSessionPoll, fail, resetToIdle],
  );

  useEffect(() => {
    scheduleBridgePollRef.current = scheduleBridgePoll;
  }, [scheduleBridgePoll]);

  const start = useCallback(() => {
    if (!adapter) return;
    if (phase !== 'idle' && phase !== 'error') return;
    setPhase('connecting');
    setError(null);
    setImported(null); // a new run supersedes the last one's "you can close it" notice
    void (async () => {
      try {
        const { url, state } = await adapter.startGooglePhotosPicker();
        const popup = window.open(url, 'google-photos-picker', 'width=520,height=680');
        if (!popup) {
          fail('popupBlocked');
          return;
        }
        popupRef.current = popup;
        scheduleBridgePoll(state, BRIDGE_POLL_INTERVAL_MS, Date.now() + BRIDGE_POLL_TIMEOUT_MS);
      } catch (err) {
        fail('startFailed', err instanceof Error ? err.message : undefined);
      }
    })();
  }, [adapter, phase, scheduleBridgePoll, fail]);

  const cancel = useCallback(() => {
    try {
      popupRef.current?.close();
    } catch {
      // A severed popup may not be closable from here — nothing to do.
    }
    setImported(null);
    resetToIdle();
  }, [resetToIdle]);

  return { enabled: Boolean(adapter), phase, error, imported, start, cancel, dismissError: resetToIdle };
}
