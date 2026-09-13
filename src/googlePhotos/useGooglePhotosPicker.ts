import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToFile } from './base64ToFile';
import type { GooglePhotosAdapter } from '../types';
import type { GooglePhotosLabels } from '../labels';

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
 *  hook (rather than using PhotoUploader's built-in button) doesn't have
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
    default:
      return labels.errors.generic;
  }
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
   * `cancel()` are no-ops, and `enabled` is `false`. PhotoUploader uses
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
}

export interface UseGooglePhotosPickerResult {
  /** False when no adapter was supplied — the whole feature is off. */
  enabled: boolean;
  phase: GooglePhotosPickerPhase;
  error: GooglePhotosPickerError | null;
  /** Set after a successful import, to how many photos were imported —
   *  the consumer decides how to phrase that (see
   *  `labels.googlePhotos.importedNotice`). Cleared when a new run
   *  starts. Not cleared automatically otherwise: once the popup has
   *  navigated through the OAuth provider's own pages this tab usually
   *  can no longer close it (see docs/google-photos-setup.md), so this
   *  is the one persistent signal that the import actually finished. */
  importedCount: number | null;
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
export function useGooglePhotosPicker({ adapter, onPhotosReady }: UseGooglePhotosPickerOptions): UseGooglePhotosPickerResult {
  const [phase, setPhase] = useState<GooglePhotosPickerPhase>('idle');
  const [error, setError] = useState<GooglePhotosPickerError | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);

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
                const { photos } = await adapter.importGooglePhotosSession(sessionId);
                if (!aliveRef.current) return;
                // Best-effort: works only if this tab still has a live
                // handle on the popup, which by this point it usually
                // does NOT — see `importedCount`'s own doc above.
                try {
                  popupRef.current?.close();
                } catch {
                  // Severed popup — not closable from here.
                }
                onPhotosReadyRef.current(photos.map((p) => base64ToFile(p.fileName, p.contentType, p.dataBase64)));
                resetToIdle();
                setImportedCount(photos.length);
              } catch (err) {
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
    setImportedCount(null); // a new run supersedes the last one's "you can close it" notice
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
    setImportedCount(null);
    resetToIdle();
  }, [resetToIdle]);

  return { enabled: Boolean(adapter), phase, error, importedCount, start, cancel, dismissError: resetToIdle };
}
