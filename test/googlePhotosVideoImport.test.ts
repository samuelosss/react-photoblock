import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS,
  resolveGooglePhotosErrorMessage,
  resolveGooglePhotosVideoErrorMessage,
  useGooglePhotosPicker,
} from '../src/googlePhotos/useGooglePhotosPicker';
import { csLabels, defaultLabels } from '../src/labels';
import type { GooglePhotosAdapter, VideoItem } from '../src/types';

function fakePopup() {
  return { closed: false, close: vi.fn() } as unknown as Window;
}

function row(id: string): VideoItem {
  return {
    id,
    status: 'processing',
    errorMessage: null,
    posterUrl: null,
    videoUrl: null,
    durationMs: null,
    byteSize: null,
    width: null,
    height: null,
  };
}

/** Drives the whole flow to the point where the import has happened. */
async function runToImport(options: {
  importResult?: unknown;
  importError?: unknown;
  entityId?: string | null;
  rerenderEntityIdTo?: string | null;
}) {
  const importGooglePhotosSession = options.importError
    ? vi.fn().mockRejectedValue(options.importError)
    : vi.fn().mockResolvedValue(options.importResult ?? { photos: [] });
  const adapter: GooglePhotosAdapter = {
    startGooglePhotosPicker: vi.fn().mockResolvedValue({ url: 'https://accounts.example.com/auth', state: 'state-1' }),
    pollGooglePhotosBridge: vi.fn().mockResolvedValue({ ready: true, sessionId: 'sess-1', pollIntervalMs: 1000 }),
    pollGooglePhotosSession: vi.fn().mockResolvedValue({ done: true, pollIntervalMs: 1000, expired: false }),
    importGooglePhotosSession,
  };
  const onPhotosReady = vi.fn();
  const onVideosReady = vi.fn();

  vi.spyOn(window, 'open').mockReturnValue(fakePopup());
  const hook = renderHook(
    ({ entityId }: { entityId: string | null }) =>
      useGooglePhotosPicker({ adapter, onPhotosReady, onVideosReady, entityId }),
    // `?? 'entity-1'` would turn an explicitly-passed null back into an
    // id, which is the very case one of these tests is about.
    { initialProps: { entityId: 'entityId' in options ? (options.entityId ?? null) : 'entity-1' } },
  );

  act(() => hook.result.current.start());
  if (options.rerenderEntityIdTo !== undefined) {
    // The real sequence this guards: the entity gets saved WHILE the user
    // is still picking in the popup.
    hook.rerender({ entityId: options.rerenderEntityIdTo });
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  return { hook, importGooglePhotosSession, onPhotosReady, onVideosReady };
}

describe('Google Photos video import', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('passes the entityId to the import, because a picked VIDEO needs a parent to attach to', async () => {
    const { importGooglePhotosSession } = await runToImport({ entityId: 'entity-7' });
    expect(importGooglePhotosSession).toHaveBeenCalledWith('sess-1', 'entity-7');
  });

  it('passes null before the entity has ever been saved', async () => {
    const { importGooglePhotosSession } = await runToImport({ entityId: null });
    expect(importGooglePhotosSession).toHaveBeenCalledWith('sess-1', null);
  });

  /**
   * The reason it is a ref and not a captured value. `entityId` goes
   * null -> a real id exactly once per form, and that save can land while
   * the popup is still open. Capturing it would import against the stale
   * null and fail for no reason the user could understand.
   */
  it('reads the entityId FRESH at import time, not as it was when the flow started', async () => {
    const { importGooglePhotosSession } = await runToImport({ entityId: null, rerenderEntityIdTo: 'entity-9' });
    expect(importGooglePhotosSession).toHaveBeenCalledWith('sess-1', 'entity-9');
  });

  it('hands imported videos and per-item failures to onVideosReady', async () => {
    const videos = [row('900'), row('901')];
    const videoErrors = [{ fileName: 'big.mov', message: 'too large', code: 'video_too_large' }];
    const { onVideosReady, hook } = await runToImport({
      importResult: { photos: [], videos, videoErrors },
    });

    expect(onVideosReady).toHaveBeenCalledWith(videos, videoErrors);
    expect(hook.result.current.imported).toEqual({ photos: 0, videos: 2, failedVideos: 1 });
    expect(hook.result.current.phase).toBe('idle');
  });

  it('treats absent videos/videoErrors as empty, so a photo-only adapter is unaffected', async () => {
    const { onVideosReady, hook } = await runToImport({
      importResult: { photos: [{ fileName: 'a.webp', contentType: 'image/webp', dataBase64: btoa('bytes') }] },
    });

    expect(onVideosReady).toHaveBeenCalledWith([], []);
    expect(hook.result.current.imported).toEqual({ photos: 1, videos: 0, failedVideos: 0 });
  });

  /**
   * The ONE import failure that rejects the whole import rather than
   * landing in a per-item entry. Reporting it as `importFailed` would
   * show "importing failed" when the real answer is "save first".
   */
  it('reports a video_needs_saved_parent rejection as its OWN error code, not importFailed', async () => {
    const err = Object.assign(new Error('video needs a saved parent'), { code: 'video_needs_saved_parent' });
    const { hook } = await runToImport({ importError: err });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'videoNeedsSavedParent' });
    expect(resolveGooglePhotosErrorMessage(hook.result.current.error!, defaultLabels.googlePhotos)).toBe(
      defaultLabels.googlePhotos.errors.videoNeedsSavedParent,
    );
  });

  it('still reports any OTHER import rejection as importFailed', async () => {
    const err = Object.assign(new Error('boom'), { code: 'something_else' });
    const { hook } = await runToImport({ importError: err });

    expect(hook.result.current.error).toEqual({ code: 'importFailed', detail: 'boom' });
  });
});

describe('resolveGooglePhotosVideoErrorMessage', () => {
  it('uses the label for a known code, prefixed with the file name', () => {
    expect(
      resolveGooglePhotosVideoErrorMessage(
        { fileName: 'clip.mov', message: 'raw english from the server', code: 'video_not_ready' },
        defaultLabels.googlePhotos,
      ),
    ).toBe(`clip.mov: ${defaultLabels.googlePhotos.videoErrors.videoNotReady}`);
  });

  /**
   * The honest escape hatch, and nothing more. The origin project typed
   * this field as a bare `string` and passed a shared pipeline's own
   * codes straight through, so codes that knew nothing about Google
   * Photos reached the user as untranslated English.
   */
  it('falls back to the server message ONLY for an unknown code or no code at all', () => {
    expect(
      resolveGooglePhotosVideoErrorMessage(
        { fileName: 'clip.mov', message: 'some future failure', code: 'video_from_the_future' },
        defaultLabels.googlePhotos,
      ),
    ).toBe('clip.mov: some future failure');
    expect(
      resolveGooglePhotosVideoErrorMessage({ fileName: 'clip.mov', message: 'no code at all' }, defaultLabels.googlePhotos),
    ).toBe('clip.mov: no code at all');
  });

  /**
   * THE TABLE IS PINNED AGAINST AN INDEPENDENT LIST, written out here by
   * hand. Everything else in this file iterates the table's own keys, so
   * REMOVING a code shrinks what gets iterated and every one of those
   * assertions passes vacuously — a mutation proved exactly that. Two
   * lists that must agree, with no test joining them, is the single most
   * repeated bug shape in this package's origin project.
   *
   * If you are adding a code: add it to the table, add its label to both
   * presets, and add it here. If you are REMOVING one, this failing is
   * the question being asked, not an obstacle.
   */
  it('pins the code table against an independent list, so dropping or renaming one fails', () => {
    expect(Object.keys(GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS).sort()).toEqual([
      'video_download_failed',
      'video_not_ready',
      'video_processing_failed',
      'video_queue_full',
      'video_too_large',
      'video_too_long',
    ]);
  });

  it('leaves no label orphaned — every videoErrors label is reachable from some code', () => {
    const reachable = new Set(Object.values(GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS));
    expect([...Object.keys(defaultLabels.googlePhotos.videoErrors)].sort()).toEqual([...reachable].sort());
  });

  it('every mapped code resolves to a real, non-empty label in BOTH shipped presets', () => {
    const codes = Object.keys(GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS);
    // Positive control: a mapping table that had gone empty would make
    // every assertion below vacuous — exactly how a check can pass while
    // proving nothing. It is NOT sufficient on its own, though: the
    // pinned list above is what catches a table that lost ONE code.
    expect(codes.length).toBeGreaterThan(0);

    for (const labels of [defaultLabels.googlePhotos, csLabels.googlePhotos]) {
      for (const code of codes) {
        const resolved = resolveGooglePhotosVideoErrorMessage({ fileName: 'f', message: 'SERVER_FALLBACK', code }, labels);
        expect(resolved).not.toContain('SERVER_FALLBACK');
        expect(resolved.length).toBeGreaterThan('f: '.length);
      }
    }
  });

  it('the Czech preset is a real translation, not a passthrough of the English copy', () => {
    for (const code of Object.keys(GOOGLE_PHOTOS_VIDEO_ERROR_LABEL_KEYS)) {
      const en = resolveGooglePhotosVideoErrorMessage({ fileName: 'f', message: 'x', code }, defaultLabels.googlePhotos);
      const cs = resolveGooglePhotosVideoErrorMessage({ fileName: 'f', message: 'x', code }, csLabels.googlePhotos);
      expect(cs).not.toBe(en);
    }
  });
});

describe('importedNotice copy', () => {
  it('names photos, videos and failures, and reads correctly when only some are present', () => {
    const notice = defaultLabels.googlePhotos.importedNotice;
    expect(notice({ photos: 2, videos: 1, failedVideos: 0 })).toBe(
      '2 photos and 1 video imported — you can close the Google Photos window.',
    );
    expect(notice({ photos: 0, videos: 1, failedVideos: 0 })).toBe(
      '1 video imported — you can close the Google Photos window.',
    );
    expect(notice({ photos: 0, videos: 0, failedVideos: 2 })).toBe(
      '2 videos could not be imported — you can close the Google Photos window.',
    );
    expect(notice({ photos: 1, videos: 0, failedVideos: 1 })).toBe(
      '1 photo imported, 1 video could not be imported — you can close the Google Photos window.',
    );
  });

  it('the Czech preset keeps its three plural forms for videos', () => {
    const notice = csLabels.googlePhotos.importedNotice;
    expect(notice({ photos: 0, videos: 1, failedVideos: 0 })).toContain('1 video je nahrané');
    expect(notice({ photos: 0, videos: 3, failedVideos: 0 })).toContain('3 videa jsou nahraná');
    expect(notice({ photos: 0, videos: 7, failedVideos: 0 })).toContain('7 videí je nahraných');
  });
});
