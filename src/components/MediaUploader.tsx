import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  useGooglePhotosPicker,
  resolveGooglePhotosErrorMessage,
  resolveGooglePhotosVideoErrorMessage,
} from '../googlePhotos/useGooglePhotosPicker';
import { mergeLabels } from '../labels';
import type { DeepPartial, MediaBlockLabels } from '../labels';
import { PhotoCropEditor } from './PhotoCropEditor';
import { LoadedImage } from './LoadedImage';
import type { LoadImage } from './LoadedImage';
import {
  buildMediaTiles,
  extractImageId,
  mediaWithout,
  syncVideosIntoMedia,
  tilesToMedia,
  tilesToMediaOrder,
} from './mediaTiles';
import type { MediaTile } from './mediaTiles';
import { estimateTranscodedBytes, resolveVideoLimits } from '../videoLimits';
import { formatDuration } from '../formatMedia';
import type {
  GooglePhotosAdapter,
  GooglePhotosVideoImportError,
  MediaItem,
  PhotoApi,
  VideoApi,
  VideoItem,
  VideoLimits,
} from '../types';
import styles from './MediaUploader.module.css';

export interface MediaUploaderProps {
  /** Null before the owning entity has ever been saved — see the module doc below. */
  entityId: string | null;
  imageUrls: string[];
  onImageUrlsChange: (urls: string[]) => void;
  /** Fires whenever the PHOTO queue changes. Video uploads are NOT folded
   *  into this: a video is processed server-side long after the request
   *  returns, so "wait for it to finish" is not something a save/leave
   *  gate can usefully hold a form open for. `pending` is true while
   *  anything is still queued or uploading; `hasErrors` is true if any
   *  item finished badly. A typical use is to hold off leaving the page
   *  until uploads have actually landed — and to NOT leave at all if one
   *  failed, so the user can see and retry it rather than losing a
   *  silently missing photo. */
  onQueueStateChange?: (state: { pending: boolean; hasErrors: boolean }) => void;
  /** The four upload/delete/reorder/replace operations — see `PhotoApi` in
   *  src/types.ts and docs/server-contract.md for what each must do
   *  server-side. Nothing in this package calls `fetch` itself. */
  api: PhotoApi;
  /**
   * Enables the "Choose from Google Photos" button. Provide all four
   * functions (see `GooglePhotosAdapter` in src/types.ts and
   * docs/google-photos-setup.md) to turn the feature on; omit this prop
   * entirely to turn it off. There is no partial/disabled state — with
   * no adapter, the button, its hook, and its network calls simply don't
   * exist.
   */
  googlePhotos?: GooglePhotosAdapter;
  /** Overrides any subset of the built-in English copy — see src/labels.ts.
   *  `csLabels` (a Czech preset) is exported if you want that instead of
   *  writing your own. Covers PhotoCropEditor's labels too, since this
   *  component renders it internally for click-to-crop. */
  labels?: DeepPartial<MediaBlockLabels>;
  /**
   * Optional: fetch an image's bytes yourself rather than letting the
   * browser do it — for a thumbnail endpoint that needs a request header
   * an `<img src>` cannot send. **Read `LoadImage`'s own doc before using
   * it**; it explains the whole reason this injection point exists and
   * why a `?token=` query parameter is not the alternative.
   *
   * ABSENT IS THE DEFAULT AND CHANGES NOTHING: every image renders as a
   * plain `<img src>`, exactly as it did before this prop existed.
   *
   * Memoize it (`useCallback`/module scope). It is a dependency of the
   * effect that fetches, so a fresh identity every render re-fetches
   * every thumbnail every render.
   */
  loadImage?: LoadImage;

  // -- Video. Every prop below is optional, and the whole video UI (the
  // second dropzone, the queue panel, video tiles in the grid, the
  // combined reorder) is gated on `video` being present. Omit it and this
  // component behaves byte-for-byte as it did before video existed.

  /**
   * The four video operations — see `VideoApi` in src/types.ts. Providing
   * this is the ONLY thing that turns video support on.
   *
   * NOTHING HERE TRANSCODES. This package accepts a file, hands it to
   * `uploadVideo`, polls `pollVideos`, renders `posterUrl` and lets the
   * user reorder it.
   */
  video?: VideoApi;
  /** Every video this entity currently has, EVERY status — mirrors
   *  `imageUrls` but as full rows, because a video needs a status, a
   *  poster and a duration where a photo needs only a URL. */
  videos?: VideoItem[];
  onVideosChange?: (videos: VideoItem[]) => void;
  /**
   * The server's ONE ordered media list — the ORDER authority for the
   * grid. `imageUrls`/`videos` above stay the CONTENT authority;
   * `buildMediaTiles`' own doc has the full split and the four reasons it
   * matters.
   *
   * Absent (`undefined`) falls back to photos-then-videos, which is
   * byte-for-byte the behaviour before this existed — so a consumer that
   * has not implemented the combined-order endpoint is unaffected, and a
   * video simply cannot be placed between two photos for them.
   */
  media?: MediaItem[];
  /**
   * Applies a new combined order to your state. REQUIRED for a moved
   * VIDEO to stick: without it a reorder can only report the new PHOTO
   * order (`onImageUrlsChange`), which cannot express a video sitting
   * between two photos — the exact reason the arrows on a video tile
   * appeared to do nothing in the origin project.
   */
  onMediaChange?: (media: MediaItem[]) => void;
  /** Client-side mirrors of your server's own video limits — see
   *  `VideoLimits`. The server is still the real enforcement. */
  videoLimits?: VideoLimits;
  /**
   * Reads a video File's duration client-side, for the BEFORE-upload size
   * estimate — defaults to a real `<video>` element probe (see
   * readVideoDurationSeconds below). Injectable because JSDOM never fires
   * `loadedmetadata` at all, so a test for this behaviour has to supply a
   * fake rather than skip it.
   */
  estimateVideoDurationSeconds?: (file: File) => Promise<number | null>;
}

interface QueueItem {
  localId: string;
  fileName: string;
  /** Local `URL.createObjectURL` preview — revoked on removal/unmount. */
  previewUrl: string;
  progress: number;
  /**
   * 'queued': picked before there was an entity id to upload against, sitting
   * in memory only, removable with no server round-trip.
   * 'uploading' / 'success' / 'error': as before — a real upload attempt.
   */
  status: 'queued' | 'uploading' | 'success' | 'error';
  error?: string;
  /** Kept so a failed or still-queued upload can proceed without re-picking. */
  file: File;
}

/**
 * Client-side lifecycle of ONE video pick, from file selection through to
 * either landing in `videos` (a server row now exists, tracked there from
 * then on — see the polling effect) or failing before ever reaching the
 * server.
 *
 * Unlike QueueItem this never reaches a 'success' status that stays in the
 * queue: the moment the upload resolves, the new row is merged into the
 * `videos` prop and this local item is dropped — the server row IS the
 * queue entry from that point on (see the video queue panel, which unions
 * this array with `videos.filter(status !== 'ready')`).
 */
interface VideoQueueItem {
  localId: string;
  fileName: string;
  file: File;
  status:
    | 'estimating' // reading duration client-side, right after picking
    | 'confirm-warn' // the estimate came back over the warn threshold; waiting on "upload anyway"
    | 'queued' // no entityId yet — mirrors QueueItem's 'queued'
    | 'uploading'
    | 'error'; // failed BEFORE a server row was ever created
  progress: number;
  error?: string;
  /** Only set while status === 'confirm-warn' — the estimate that triggered it. */
  estimateBytes?: number;
}

/**
 * How often to ask `pollVideos` whether a 'processing' row has moved.
 *
 * A fixed constant rather than a prop: it is a polling cadence, not a
 * server limit, and 4 seconds is slow enough to be free (one small JSON
 * read) and fast enough that a short clip finishing feels immediate. The
 * poll only runs while a row is actually 'processing' and stops itself the
 * moment none is, so an idle form makes no requests at all.
 */
const VIDEO_POLL_INTERVAL_MS = 4000;

let uidCounter = 0;
function nextLocalId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/**
 * Cropping a queued (not-yet-uploaded) photo produces fresh bytes entirely
 * client-side (PhotoCropEditor's `onSave` always hands back `image/webp` —
 * see that component's own "Encoding choice" doc) — this swaps the
 * original extension for `.webp` so the name travelling with the eventual
 * upload actually matches what's inside it. That matters for two real
 * things downstream, not just cosmetics: a typical backend's own MIME
 * check keys off the FormData part's content type (which a real `File`'s
 * own `.type` drives — see the `new File([blob], ...)` call at the
 * crop-save site below), and `file.name` is often what a backend echoes
 * back in its own error messages — seeing "sunset.jpg" fail to convert
 * when the bytes are actually WebP would be a confusing report to debug.
 */
function toWebpFilename(originalName: string): string {
  const base = originalName.replace(/\.[^./]+$/, '');
  return `${base || 'photo'}.webp`;
}

/**
 * Reads a video File's duration via a throwaway `<video>` element — never
 * attached to the DOM, so nothing renders. Resolves `null` (rather than
 * rejecting) if the browser can't read metadata for this file (corrupt,
 * or a format-in-name-only file); callers treat that as "can't estimate,
 * don't warn" rather than blocking the pick.
 *
 * This is metadata only. It is NOT a decode, NOT a transcode, and does not
 * make this package aware of codecs — the browser answers or it doesn't.
 */
function readVideoDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    const cleanup = () => URL.revokeObjectURL(url);
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
      cleanup();
      resolve(duration);
    };
    el.onerror = () => {
      cleanup();
      resolve(null);
    };
    el.src = url;
  });
}

/**
 * What's open in the crop editor: either an EXISTING, already-uploaded
 * photo (`imageId` resolves against the entity's real image set, replaced
 * in place via `api.replaceImage` — the original, only path) or a QUEUED
 * one that has never touched the server (`localId` resolves against
 * `queue`, cropped purely in memory — see handleCropSave's 'queued'
 * branch below). The two need different data to open (a server imageId
 * vs a local queue id) and different save behaviour, so this is a
 * discriminated union rather than trying to force one shape to cover
 * both. Video has no crop step at all.
 */
type CropTarget = { type: 'existing'; url: string; imageId: string } | { type: 'queued'; localId: string };

/**
 * Multi-photo (and, when a `VideoApi` is injected, multi-video) picker and
 * uploader: pick/drag files, watch them upload with per-file progress,
 * reorder by drag or keyboard, click any photo to crop/rotate it, delete,
 * and (optionally) import from Google Photos.
 *
 * All server interaction is injected — see `PhotoApi`, `VideoApi` and
 * `GooglePhotosAdapter` in src/types.ts — so this component has no fetch,
 * no HTTP client, and no opinion about your backend's URL scheme beyond
 * the `/images/<id>` shape `extractImageId` parses back out of the URLs
 * you hand it.
 *
 * Works from the moment a NEW-entity form opens, before it has been saved
 * (`entityId` is null): picking files creates instant local previews
 * (`URL.createObjectURL`) and queues them in component state — nothing is
 * uploaded and no draft entity is created just to get an id. Once the
 * consumer saves the entity for the first time and passes a real
 * `entityId`, every still-queued file starts uploading automatically, in
 * the same order it was picked. Picking files against an already-saved
 * entity (entityId present from the start) uploads immediately.
 *
 * Uploads run one file at a time (not all at once) so progress is legible
 * on a slow mobile connection and so a dropped connection only ever loses
 * the ONE file in flight — files already queued stay queued and are tried
 * in turn.
 *
 * VIDEO is additive and entirely optional. With `video` supplied:
 *   - a second dropzone accepts the containers in `videoLimits`;
 *   - picking a file estimates its transcoded size client-side and asks
 *     for confirmation over `sizeWarnBytes` — soft, never blocking;
 *   - the upload is expected to answer immediately with a 'processing'
 *     row; this component polls `pollVideos` until it becomes 'ready' or
 *     'failed';
 *   - a READY video joins the SAME grid as the photos, sharing the same
 *     drag/keyboard reorder;
 *   - 'processing'/'failed' videos live in their own queue panel — they
 *     have no poster yet (or never will), and a blank tile in the mosaic
 *     is not an improvement.
 *
 * COMBINED ORDER: the grid's order comes from the `media` prop — ONE
 * ordered list your server merges across its photos and videos. See
 * mediaTiles.ts's buildMediaTiles for the order/content split and why the
 * merge rule deliberately does NOT live here.
 */
export function MediaUploader({
  entityId,
  imageUrls,
  onImageUrlsChange,
  onQueueStateChange,
  api,
  googlePhotos,
  labels,
  loadImage,
  video,
  videos,
  onVideosChange,
  media,
  onMediaChange,
  videoLimits,
  estimateVideoDurationSeconds = readVideoDurationSeconds,
}: MediaUploaderProps) {
  const t = mergeLabels(labels);
  const videoMode = Boolean(video);
  const videoRows = videos ?? [];
  const limits = resolveVideoLimits(videoLimits);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  // Counts nested dragenter/dragleave pairs rather than a plain boolean —
  // the dropzone's own children (the label text) fire their own
  // enter/leave as the pointer crosses them, so a naive boolean flickers
  // off mid-drag every time the cursor passes over a child element.
  const [dragDepth, setDragDepth] = useState(0);
  // Reorder in-flight guard — a REF, not state, so it causes no re-render
  // and never disables (and so never blurs) a move button; see moveOne()'s
  // comment for why that matters for keyboard operability. A polite
  // aria-live announcement covers the keyboard/screen-reader path — drag &
  // drop is not perceivable to a screen reader at all, so the move
  // buttons are the ONLY way a keyboard/AT user can reorder, and they need
  // their own feedback independent of any visual reshuffling.
  const reorderInFlightRef = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const dragSourceIndexRef = useRef<number | null>(null);
  // A keyboard move-left/move-right re-sorts the grid, and React's `key`
  // reconciliation relocates that tile's DOM node to its new position.
  // In a real browser, relocating a focused element does NOT by itself
  // blur it — but the last move in a sequence can land the tile at an END
  // index, which makes that same, still-focused button `disabled` (see
  // the grid's `disabled={index === tiles.length - 1}` below), and
  // disabling a focused element does blur it to <body> in every evergreen
  // browser, same as clicking a plain `disabled` toggle would. So the fix
  // is an explicit refocus after the move, not merely avoiding a
  // disabled-state change. `pendingFocusRef` records which tile/direction
  // requested a move; the effect below finds that SAME tile's new index
  // once the grid's props actually update, and refocuses its move button
  // there — same direction if still enabled (so a keyboard user can keep
  // pressing to keep moving it), else the opposite direction, else the
  // tile's edit button (photos only — a video tile has none) as a last
  // resort.
  // NOTE: JSDOM has no real focus-management engine, so this specific
  // loss-of-focus failure mode cannot be reproduced or asserted against
  // in a JSDOM test at all — only the effect's own wiring (does it call
  // `.focus()` on the right element) can be. See the README's
  // Limitations section and e2e/media-uploader-focus.spec.ts.
  const pendingFocusRef = useRef<{ tileKey: string; direction: 'left' | 'right' } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Click-to-crop: which photo (if any) is open in the editor — see
  // CropTarget's own doc for why this covers both an existing, uploaded
  // photo and a still-queued one.
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const [cropSaving, setCropSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const prevEntityIdRef = useRef<string | null>(entityId);

  // -- Video-only state (inert when videoMode is false) --
  const [videoQueue, setVideoQueue] = useState<VideoQueueItem[]>([]);
  const videoQueueRef = useRef<VideoQueueItem[]>([]);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [videoDragDepth, setVideoDragDepth] = useState(0);
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(new Set());
  /**
   * Remembers the File behind a video row THIS TAB uploaded, keyed by the
   * server's video id, purely so "retry" on a 'failed' row can re-send
   * the same bytes without asking the user to re-pick the file. A ref
   * (not state): it is write-once-per-id, read-only-on-click, and must
   * survive without triggering re-renders of its own. It is NOT persisted
   * anywhere — after a page reload, or if the failure is discovered by
   * reopening the form later, this map is empty and retry falls back to
   * telling the user to re-select the file (see handleRetryFailedVideo)
   * rather than being a button that silently does nothing.
   */
  const uploadedFilesRef = useRef<Map<string, File>>(new Map());
  const videosRef = useRef<VideoItem[]>(videoRows);
  /**
   * The latest `media` prop, for the handlers that run outside render —
   * the polling interval above all, whose closure would otherwise hold
   * whatever `media` was when the effect last re-ran. Same discipline as
   * `videosRef`, and `undefined` stays `undefined`: a consumer with no
   * server `media` must keep falling back to photos-then-videos, and
   * there is no way to un-set a prop once something has handed it an
   * array (see reorderTo's revert for the same constraint).
   */
  const mediaRef = useRef<MediaItem[] | undefined>(media);

  /** Per-item failures from the LAST Google Photos import, already
   *  resolved to display text. Cleared when the next run starts, same
   *  lifecycle as the hook's own `imported`. */
  const [googlePhotosVideoErrors, setGooglePhotosVideoErrors] = useState<string[]>([]);

  useEffect(() => {
    videosRef.current = videoRows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  /**
   * Hands the consumer a `media` list derived from the one currently in
   * `mediaRef` — the single door every path that has NO server `media` in
   * its response goes through (both deletes, the video upload, the status
   * poll).
   *
   * Does nothing at all when the consumer supplies no `media`: that
   * consumer is on the documented photos-then-videos fallback, and
   * inventing an array here would silently opt it into `media` being the
   * order authority. A path that DOES have server `media` must apply that
   * instead of deriving; the server owns the merge rule, not this
   * component.
   */
  function updateMediaFrom(derive: (current: MediaItem[]) => MediaItem[]) {
    const current = mediaRef.current;
    if (!current) return;
    onMediaChange?.(derive(current));
  }

  useEffect(() => {
    queueRef.current = queue;
    onQueueStateChange?.({
      pending: queue.some((item) => item.status === 'queued' || item.status === 'uploading'),
      hasErrors: queue.some((item) => item.status === 'error'),
    });
    // onQueueStateChange is a plain callback prop, not reactive state this
    // effect should re-run for — only `queue` changing matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  useEffect(() => {
    videoQueueRef.current = videoQueue;
  }, [videoQueue]);

  // Revoke every preview URL still alive when this component unmounts —
  // otherwise each picked photo leaks its object URL for the life of the tab.
  useEffect(() => {
    return () => {
      queueRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    };
  }, []);

  // handleFiles/handleVideosReady are hoisted function declarations
  // (defined further below in this component) — safe to reference here
  // regardless of source order. The hook is ALWAYS called (React's rules
  // of hooks forbid calling it conditionally); when `googlePhotos` is
  // undefined, the hook itself is inert (`enabled: false`, no
  // timers/listeners) — see its own doc. Both callbacks are plain
  // functions recreated every render, but the hook only ever reads the
  // LATEST one via its own internal refs, so a fresh closure here is
  // never a reason for it to tear down and recreate anything.
  const picker = useGooglePhotosPicker({
    adapter: googlePhotos,
    onPhotosReady: (files) => handleFiles(files),
    // Read fresh at import time inside the hook — see its `entityId` doc.
    entityId,
    onVideosReady: videoMode ? (newVideos, errors) => handleVideosReady(newVideos, errors) : undefined,
  });

  // A fresh start() run supersedes whatever the last one reported — same
  // lifecycle as the hook's own `imported`.
  useEffect(() => {
    if (picker.phase === 'connecting') setGooglePhotosVideoErrors([]);
  }, [picker.phase]);

  /**
   * Merges videos imported from Google Photos into the SAME `videos` prop
   * local uploads use — they arrive exactly as `uploadVideo` returns one
   * (a server-created 'processing' row), so the existing polling effect
   * below takes them to 'ready'/'failed' with no new machinery at all.
   */
  function handleVideosReady(newVideos: VideoItem[], errors: GooglePhotosVideoImportError[]) {
    if (newVideos.length > 0) {
      const merged = [...videosRef.current, ...newVideos];
      onVideosChange?.(merged);
      // Same reason as a local video upload: the import answers with
      // ROWS, so `media` is extended rather than replaced.
      updateMediaFrom((current) => syncVideosIntoMedia(current, merged));
    }
    setGooglePhotosVideoErrors(errors.map((entry) => resolveGooglePhotosVideoErrorMessage(entry, t.googlePhotos)));
  }

  function updateItem(localId: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)));
  }

  const uploadOne = useCallback(
    async (targetEntityId: string, item: QueueItem) => {
      updateItem(item.localId, { status: 'uploading', progress: 0, error: undefined });
      const result = await api.uploadPhoto(targetEntityId, item.file, (percent) => {
        updateItem(item.localId, { progress: percent });
      });
      if (result.status === 'success') {
        updateItem(item.localId, { status: 'success', progress: 100 });
        // Use the server's own fresh image list (returned by the upload
        // response) rather than guessing the new URL/id client-side.
        if (result.imageUrls) onImageUrlsChange(result.imageUrls);
        // ...and its ordered `media` for the same reason, which is the
        // stronger one: `imageUrls` carries no position, so applying it
        // alone leaves `media` on its pre-upload value and the new photo
        // is appended to buildMediaTiles' unknown tail — behind every
        // video, wherever the server actually put it. See
        // UploadResult.media; this was a real shipped bug.
        if (result.media) onMediaChange?.(result.media);
      } else {
        updateItem(item.localId, { status: 'error', error: result.error });
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, onImageUrlsChange, onMediaChange],
  );

  // The moment `entityId` first becomes real (the entity's first save just
  // happened), upload everything that was queued while it was still null —
  // both photos and (if any were picked before the first save) videos.
  useEffect(() => {
    const previous = prevEntityIdRef.current;
    prevEntityIdRef.current = entityId;
    if (previous || !entityId) return;

    const stillQueued = queueRef.current.filter((item) => item.status === 'queued');
    const stillQueuedVideos = videoQueueRef.current.filter((item) => item.status === 'queued');
    if (stillQueued.length === 0 && stillQueuedVideos.length === 0) return;

    (async () => {
      // Sequential, not Promise.all — see module doc.
      for (const item of stillQueued) {
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(entityId, item);
      }
      for (const item of stillQueuedVideos) {
        // eslint-disable-next-line no-await-in-loop
        await uploadOneVideo(entityId, item);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  /**
   * Shared by the file-input's onChange and the dropzone's onDrop — both
   * ultimately hand this the same kind of File[], so both go through one
   * path rather than duplicating the queue/upload-kickoff logic.
   */
  function handleFiles(files: File[]) {
    if (files.length === 0) return;

    const items: QueueItem[] = files.map((file) => ({
      localId: nextLocalId('upload'),
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      progress: 0,
      status: entityId ? 'uploading' : 'queued',
      file,
    }));
    setQueue((prev) => [...prev, ...items]);

    if (entityId) {
      const targetEntityId = entityId;
      // Sequential, not Promise.all: on a slow phone connection this keeps
      // progress meaningful (one bar moving at a time) and avoids competing
      // for the same limited uplink.
      (async () => {
        for (const item of items) {
          // eslint-disable-next-line no-await-in-loop
          await uploadOne(targetEntityId, item);
        }
      })();
    }
    // If there's no entityId yet, the items just sit in the queue with
    // status 'queued' until the entity is saved — see the effect above.
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ''; // allow re-selecting the same file later
    handleFiles(files);
  }

  // Drag-and-drop onto the same dropzone the click-to-pick label already
  // renders as (it's already styled as a dashed dropzone — see .pickLabel).
  // preventDefault on dragOver is required or the browser's default action
  // (usually "open the file") fires instead of allowing a drop at all.
  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragDepth((depth) => depth + 1);
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragDepth((depth) => Math.max(0, depth - 1));
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragDepth(0);
    // The <input accept="image/*"> only filters what the OS file dialog
    // shows — a drop bypasses that dialog entirely, so a non-image file
    // dragged in (a PDF, say) would otherwise reach handleFiles unfiltered.
    // A backend's own MIME check is still the real enforcement; this is
    // just parity with what picking a file already implicitly filtered to.
    const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'));
    handleFiles(files);
  }

  async function handleRetry(item: QueueItem) {
    if (!entityId) return; // shouldn't happen — retry only shows on 'error', which requires an attempt
    await uploadOne(entityId, item);
  }

  function handleRemoveQueued(localId: string) {
    setQueue((prev) => {
      const item = prev.find((i) => i.localId === localId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((i) => i.localId !== localId);
    });
  }

  // ---------------------------------------------------------------------
  // The combined grid: photos + READY videos, one drag/keyboard reorder.
  // ---------------------------------------------------------------------

  // See mediaTiles.ts — `media` is the ORDER authority, imageUrls/videos
  // the CONTENT authority, and an absent `media` means the old
  // photos-then-videos derivation.
  const tiles: MediaTile[] = buildMediaTiles({ imageUrls, videos: videoRows, media, videoMode });

  /** React key and focus key for a tile. Namespaced by kind because a
   *  photo id and a video id can collide — see mediaTileKey. */
  function tileKey(tile: MediaTile): string {
    return tile.kind === 'photo' ? `photo:${tile.mediaId}` : `video:${tile.mediaId}`;
  }

  function moveLabel(tile: MediaTile, index: number, total: number, direction: 'left' | 'right'): string {
    if (tile.kind === 'video') {
      return direction === 'left' ? t.uploader.moveLeftVideo(index, total) : t.uploader.moveRightVideo(index, total);
    }
    return direction === 'left' ? t.uploader.moveLeft(index, total) : t.uploader.moveRight(index, total);
  }

  /**
   * Applies a new combined order, optimistically (so the UI reshuffles
   * instantly), then confirms it with the server — reverting back to the
   * previous order and alerting if the request fails, same failure-handling
   * shape as handleDeleteExisting below. Prefers `video.reorderMedia` (the
   * combined endpoint) whenever video support is wired in; falls back to
   * the photo-only `api.reorderImages` otherwise, which is exactly the
   * pre-video behaviour.
   *
   * The optimistic update MUST report the new media order, not just the
   * new photo order: `imageUrls` cannot express a video between two
   * photos, so before `onMediaChange` existed a video tile reshuffled for
   * one frame (or not at all) and then snapped back.
   */
  async function reorderTo(newTiles: MediaTile[], announceText: string) {
    if (!entityId) return;
    const previousImageUrls = imageUrls;
    const previousVideos = videoRows;
    const previousMedia = media;
    const previousTiles = tiles;
    onImageUrlsChange(newTiles.filter((tile) => tile.kind === 'photo').map((tile) => (tile as { url: string }).url));
    onMediaChange?.(tilesToMedia(newTiles, previousMedia));
    setAnnouncement(announceText);
    reorderInFlightRef.current = true;
    try {
      if (video) {
        // Structurally contains photos + READY videos only — see
        // tilesToMediaOrder and docs/server-contract.md §8.
        const result = await video.reorderMedia(entityId, tilesToMediaOrder(newTiles));
        onImageUrlsChange(result.imageUrls);
        onVideosChange?.(result.videos);
        // The server's own merged order wins over the optimistic guess —
        // it, not the client, owns the tie-breaking rule. When a backend
        // returns no `media`, keeping the optimistic order is the
        // deliberate choice: re-deriving photos-then-videos from
        // `result.imageUrls` is exactly the snap-back this exists to
        // remove.
        if (result.media) onMediaChange?.(result.media);
      } else {
        const result = await api.reorderImages(
          entityId,
          newTiles.map((tile) => tile.mediaId),
        );
        if (result.imageUrls) onImageUrlsChange(result.imageUrls);
        if (result.media) onMediaChange?.(result.media);
      }
    } catch (err) {
      onImageUrlsChange(previousImageUrls);
      onVideosChange?.(previousVideos);
      // `previousMedia` may be undefined (a consumer that supplies
      // onMediaChange but has no server `media` yet). There is no way to
      // un-set a prop, so revert to the order that was actually on screen
      // — which is what `previousTiles` is.
      onMediaChange?.(previousMedia ?? tilesToMedia(previousTiles));
      setAnnouncement(t.uploader.reorderFailedAnnouncement);
      window.alert(err instanceof Error ? err.message : t.uploader.reorderFailedAlert);
    } finally {
      reorderInFlightRef.current = false;
    }
  }

  /**
   * `reorderInFlightRef` (a ref, not state) guards against a double-fire
   * while a request is in flight WITHOUT disabling the move buttons —
   * disabling the just-pressed button would blur it to <body> in a real
   * browser, forcing a keyboard user to Tab back into the grid after
   * every single move. A ref causes no re-render, so nothing about the
   * button's focusability changes; a click while a request is already
   * running is simply ignored rather than queued.
   *
   * `source`: only a KEYBOARD move (handleMoveLeft/handleMoveRight) sets
   * `pendingFocusRef`, which drives the refocus effect below. A mouse
   * drag & drop (handleTileDrop) also calls this function — same
   * reorder, same API call — but must NOT request a refocus: nothing
   * about a pointer-only drag ever moved keyboard focus away from
   * wherever it already was, so unconditionally refocusing a 28px arrow
   * button after the drop would steal focus from whatever the mouse
   * cursor was actually doing next. (Found by an adversarial review in
   * the origin project: focus an unrelated button, then drag-and-drop a
   * tile — the shipped code moved focus onto a move button anyway, so the
   * next Space/Enter hit that button instead of what had been clicked.)
   */
  function moveOne(
    fromIndex: number,
    toIndex: number,
    direction: 'left' | 'right',
    source: 'keyboard' | 'pointer' = 'keyboard',
  ) {
    if (toIndex < 0 || toIndex >= tiles.length || fromIndex === toIndex) return;
    if (reorderInFlightRef.current) return;
    if (source === 'keyboard') {
      const movedTile = tiles[fromIndex];
      if (movedTile) pendingFocusRef.current = { tileKey: tileKey(movedTile), direction };
    }
    const next = [...tiles];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    // Names the FROM and TO positions — not the underlying database id
    // (meaningless to a screen-reader user) — so two different moves that
    // happen to land on the same destination (e.g. 1->2, then later 3->2)
    // still read as distinguishable sentences instead of an identical one
    // twice. The noun differs once the grid can hold more than photos.
    const announce =
      tiles.length === imageUrls.length ? t.uploader.moveAnnouncement : t.uploader.mediaMoveAnnouncement;
    void reorderTo(next, announce(fromIndex + 1, toIndex + 1, tiles.length));
  }

  /**
   * Refocuses the moved tile's move button once the DOM has actually
   * relocated it (see pendingFocusRef's comment above) — depends on
   * `imageUrls`/`videos`/`media` (props), which only take on their new
   * order after the consumer re-renders with the values
   * `onImageUrlsChange`/`onVideosChange`/`onMediaChange` handed it.
   *
   * All three belong in the dep list because this effect reads `tiles`,
   * and `tiles` is derived from all three. They are mutually redundant at
   * today's call sites — `reorderTo` hands the consumer a fresh array
   * through all three callbacks, so any one of them on its own re-runs
   * this effect — but "something else happens to change too" is an
   * argument about today's call sites, not about what the effect reads.
   */
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const newIndex = tiles.findIndex((tile) => tileKey(tile) === pending.tileKey);
    if (newIndex === -1 || !gridRef.current) return;
    const total = tiles.length;
    const tile = tiles[newIndex]!;
    const sameDirLabel = moveLabel(tile, newIndex + 1, total, pending.direction);
    const otherDirLabel = moveLabel(tile, newIndex + 1, total, pending.direction === 'left' ? 'right' : 'left');
    const target =
      gridRef.current.querySelector<HTMLButtonElement>(`button[aria-label="${sameDirLabel}"]:not(:disabled)`) ??
      gridRef.current.querySelector<HTMLButtonElement>(`button[aria-label="${otherDirLabel}"]:not(:disabled)`) ??
      // A video tile has no edit button, so this last resort only ever
      // resolves for a photo.
      gridRef.current.querySelector<HTMLButtonElement>(
        `button[aria-label="${t.uploader.editExisting(newIndex + 1, total)}"]`,
      );
    target?.focus();
    // Only ever needs to react to the grid's own contents actually
    // changing — pending is read fresh from the ref each run, not a
    // reactive dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrls, videos, media]);

  function handleMoveLeft(index: number) {
    moveOne(index, index - 1, 'left');
  }

  function handleMoveRight(index: number) {
    moveOne(index, index + 1, 'right');
  }

  function handleTileDragStart(index: number) {
    return (event: DragEvent<HTMLDivElement>) => {
      dragSourceIndexRef.current = index;
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };
  }

  // Required so the browser actually allows a drop here at all (same
  // reasoning as the file-drop zone's handleDragOver above).
  function handleTileDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  function handleTileDrop(index: number) {
    return (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const from = dragSourceIndexRef.current;
      dragSourceIndexRef.current = null;
      if (from === null) return;
      // 'pointer' source: a mouse drag must not trigger the keyboard
      // refocus effect — see moveOne's own comment.
      moveOne(from, index, index > from ? 'right' : 'left', 'pointer');
    };
  }

  /**
   * Clears the drag source on EVERY drag end, successful drop or not —
   * without this, an abandoned/cancelled internal drag (e.g. released
   * outside any valid drop target) left a stale index behind, and a
   * LATER, completely unrelated drag (even a FILE dragged in from the
   * desktop onto a tile, which never fires our own onDragStart) would
   * read that stale index and fire a bogus reorder.
   */
  function handleTileDragEnd() {
    dragSourceIndexRef.current = null;
  }

  function handleOpenCrop(url: string) {
    const imageId = extractImageId(url);
    if (!imageId) return;
    setCropTarget({ type: 'existing', url, imageId });
  }

  /**
   * Opens the crop editor for a still-QUEUED photo (no server round trip
   * involved at all — see handleCropSave's 'queued' branch). Gated by the
   * caller to only ever fire for 'queued' or 'error' items (see the queue
   * grid below); 'uploading' shows the same control but disabled, and
   * 'success' hides it entirely since that photo now lives in the saved
   * grid above with its own, already-working edit button.
   */
  function handleOpenCropQueued(localId: string) {
    setCropTarget({ type: 'queued', localId });
  }

  function handleCropCancel() {
    setCropTarget(null);
  }

  /**
   * Handles BOTH crop targets (see CropTarget's doc). The 'existing'
   * branch calls `api.replaceImage` and trusts its returned imageUrls.
   * The 'queued' branch never touches the network: PhotoCropEditor
   * already hands back a ready-to-upload `image/webp` Blob (see its own
   * "Encoding choice" doc), so this just swaps that Blob in for the queue
   * item's `file`, wrapped as a real `File` (not a bare Blob) so the
   * eventual FormData upload carries a sensible name/type — see
   * toWebpFilename's own doc for why that matters beyond cosmetics. The
   * old blob: preview URL is explicitly revoked before the new one
   * replaces it in state, same discipline as unmount and the
   * remove-from-queue path (handleRemoveQueued) — an object URL nobody
   * revokes leaks for the life of the tab.
   */
  async function handleCropSave(blob: Blob) {
    if (!cropTarget) return;
    setCropSaving(true);
    try {
      if (cropTarget.type === 'existing') {
        if (!entityId) return;
        const result = await api.replaceImage(entityId, cropTarget.imageId, blob);
        // A server implementing docs/server-contract.md's "replace in
        // place" section returns imageUrls that already carry a fresh
        // cache-busting version token for the just-replaced image, so the
        // browser treats it as a new resource and this view updates
        // immediately — no client-side cache-busting needed here.
        if (result.imageUrls) onImageUrlsChange(result.imageUrls);
        // A crop changes no positions, so this is not fixing a visible
        // bug — but leaving `media` holding the PRE-crop url for this id
        // means the stale `?v=` token is what a later optimistic reorder
        // would carry (tilesToMedia keeps `previous` entries it finds no
        // tile for). Cheaper to stay consistent than to reason about
        // which stale field is harmless.
        if (result.media) onMediaChange?.(result.media);
        setCropTarget(null);
        return;
      }

      const item = queueRef.current.find((i) => i.localId === cropTarget.localId);
      if (!item) {
        // Item vanished from under us (shouldn't happen — the modal
        // overlay blocks interaction with the queue while open — but fail
        // safe rather than throw).
        setCropTarget(null);
        return;
      }
      const croppedFile = new File([blob], toWebpFilename(item.fileName), { type: 'image/webp' });
      const newPreviewUrl = URL.createObjectURL(croppedFile);
      URL.revokeObjectURL(item.previewUrl);
      // Both the upload payload (`file`) AND the visible name (`fileName`)
      // move together — showing "sunset.jpg" next to bytes that are
      // actually "sunset.webp" would be its own small, confusing lie.
      updateItem(item.localId, { file: croppedFile, fileName: croppedFile.name, previewUrl: newPreviewUrl });
      setCropTarget(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.uploader.cropSaveFailedAlert);
    } finally {
      setCropSaving(false);
    }
  }

  async function handleDeleteExisting(url: string) {
    if (!entityId) return;
    const imageId = extractImageId(url);
    if (!imageId) return;
    if (!window.confirm(t.uploader.confirmDelete)) return;
    setDeletingUrl(url);
    try {
      await api.deleteImage(entityId, imageId);
      onImageUrlsChange(imageUrls.filter((u) => u !== url));
      // A delete conventionally answers with no body, so there is no
      // fresh `media` to apply — see mediaWithout's doc for why dropping
      // the entry matters even though the grid already renders correctly
      // without it.
      updateMediaFrom((current) => mediaWithout(current, 'image', imageId));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.uploader.deleteFailed);
    } finally {
      setDeletingUrl(null);
    }
  }

  const successCount = queue.filter((q) => q.status === 'success').length;
  const errorCount = queue.filter((q) => q.status === 'error').length;
  const queuedCount = queue.filter((q) => q.status === 'queued').length;

  // The URL PhotoCropEditor actually renders — resolved from whichever
  // union member cropTarget currently is. `undefined` (not found) closes
  // the editor below rather than handing it a broken src.
  const cropImageUrl =
    cropTarget?.type === 'existing'
      ? cropTarget.url
      : cropTarget?.type === 'queued'
        ? queue.find((item) => item.localId === cropTarget.localId)?.previewUrl
        : undefined;

  // ---------------------------------------------------------------------
  // Video: pick -> (estimate -> maybe confirm) -> upload -> poll -> ready
  // ---------------------------------------------------------------------

  function updateVideoItem(localId: string, patch: Partial<VideoQueueItem>) {
    setVideoQueue((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)));
  }

  function removeVideoQueueItem(localId: string) {
    setVideoQueue((prev) => prev.filter((item) => item.localId !== localId));
  }

  async function uploadOneVideo(targetEntityId: string, item: VideoQueueItem) {
    if (!video) return;
    updateVideoItem(item.localId, { status: 'uploading', progress: 0, error: undefined });
    const result = await video.uploadVideo(targetEntityId, item.file, (percent) => {
      updateVideoItem(item.localId, { progress: percent });
    });
    if (result.status === 'success' && result.video) {
      const row = result.video;
      uploadedFilesRef.current.set(row.id, item.file);
      const merged = [...videosRef.current, row];
      onVideosChange?.(merged);
      // The response carries the new ROW, not the entity, so `media` has
      // to be extended here rather than replaced — see
      // syncVideosIntoMedia. The new row is 'processing' and so is not a
      // tile yet, but leaving `media` without it means the order list and
      // the content list disagree about what this entity holds, which is
      // what every bug in this family has looked like.
      updateMediaFrom((current) => syncVideosIntoMedia(current, merged));
      removeVideoQueueItem(item.localId);
    } else {
      updateVideoItem(item.localId, { status: 'error', error: result.error ?? t.uploader.videoUploadFailed });
    }
  }

  /** Runs the estimate-then-maybe-warn gate for one freshly-picked video
   *  file, then either uploads it (entityId present) or queues it
   *  (mirrors handleFiles' photo path). */
  async function admitVideoFile(file: File) {
    const localId = nextLocalId('video-upload');
    const base: VideoQueueItem = { localId, fileName: file.name, file, status: 'estimating', progress: 0 };
    setVideoQueue((prev) => [...prev, base]);

    if (file.size > limits.maxBytes) {
      updateVideoItem(localId, { status: 'error', error: t.uploader.videoTooLarge(file.size, limits.maxBytes) });
      return;
    }

    const durationSeconds = await estimateVideoDurationSeconds(file);
    if (durationSeconds !== null && durationSeconds > limits.maxDurationSeconds) {
      updateVideoItem(localId, {
        status: 'error',
        error: t.uploader.videoTooLong(durationSeconds, limits.maxDurationSeconds),
      });
      return;
    }

    const estimateBytes = durationSeconds !== null ? estimateTranscodedBytes(durationSeconds, videoLimits) : null;
    if (estimateBytes !== null && estimateBytes > limits.sizeWarnBytes) {
      updateVideoItem(localId, { status: 'confirm-warn', estimateBytes });
      return;
    }

    proceedWithVideo(localId, file);
  }

  /** Moves a video past the (skipped or confirmed) warning gate into
   *  'queued'/'uploading', the same branch handleFiles takes for photos. */
  function proceedWithVideo(localId: string, file: File) {
    if (entityId) {
      updateVideoItem(localId, { status: 'uploading', estimateBytes: undefined });
      const item = videoQueueRef.current.find((i) => i.localId === localId) ?? {
        localId,
        fileName: file.name,
        file,
        status: 'uploading' as const,
        progress: 0,
      };
      void uploadOneVideo(entityId, { ...item, file });
    } else {
      updateVideoItem(localId, { status: 'queued', estimateBytes: undefined });
    }
  }

  function handleVideoFiles(files: File[]) {
    const accepted = files.filter((file) => limits.acceptedMimeTypes.includes(file.type.toLowerCase()));
    accepted.forEach((file) => void admitVideoFile(file));
  }

  function handleVideoFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    handleVideoFiles(files);
  }

  function handleVideoDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
  }

  function handleVideoDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setVideoDragDepth((depth) => depth + 1);
  }

  function handleVideoDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setVideoDragDepth((depth) => Math.max(0, depth - 1));
  }

  function handleVideoDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setVideoDragDepth(0);
    const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.type.startsWith('video/'));
    handleVideoFiles(files);
  }

  function handleConfirmVideoWarn(item: VideoQueueItem) {
    proceedWithVideo(item.localId, item.file);
  }

  function handleCancelVideoQueued(localId: string) {
    removeVideoQueueItem(localId);
  }

  async function handleRetryLocalVideo(item: VideoQueueItem) {
    if (!entityId) return;
    await uploadOneVideo(entityId, item);
  }

  /**
   * Retries a video whose row reached 'failed' AFTER a server row already
   * existed (a transcode failure — the local queue item is long gone by
   * then, see uploadOneVideo's success branch). Only possible if THIS
   * BROWSER TAB is the one that uploaded it (uploadedFilesRef still holds
   * the File) — a fresh page load, or a failure discovered on a LATER
   * visit to this form, has no bytes to resend. In that case this deletes
   * the failed row and tells the user to re-pick the file, rather than a
   * button that looks like it does something but silently no-ops.
   */
  async function handleRetryFailedVideo(row: VideoItem) {
    if (!entityId || !video) return;
    const file = uploadedFilesRef.current.get(row.id);
    try {
      await video.deleteVideo(entityId, row.id);
      onVideosChange?.(videosRef.current.filter((v) => v.id !== row.id));
      // No response body — same derivation as the photo delete above.
      updateMediaFrom((current) => mediaWithout(current, 'video', row.id));
      uploadedFilesRef.current.delete(row.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.uploader.deleteVideoFailed);
      return;
    }
    if (file) {
      void admitVideoFile(file);
    } else {
      window.alert(t.uploader.videoRetryUnavailable);
    }
  }

  async function handleDeleteVideoRow(row: VideoItem) {
    if (!entityId || !video) return;
    if (!window.confirm(t.uploader.confirmDeleteVideo)) return;
    try {
      await video.deleteVideo(entityId, row.id);
      onVideosChange?.(videosRef.current.filter((v) => v.id !== row.id));
      // No response body — same derivation as the photo delete above.
      updateMediaFrom((current) => mediaWithout(current, 'video', row.id));
      uploadedFilesRef.current.delete(row.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t.uploader.deleteVideoFailed);
    }
  }

  function dismissWarning(videoId: string) {
    setDismissedWarnings((prev) => new Set(prev).add(videoId));
  }

  // Polls `pollVideos` while any row is still 'processing'. A transcode
  // runs far longer than any single request, so asking again is the only
  // way this component learns a row became 'ready'/'failed'. Stops itself
  // the moment nothing is 'processing' anymore; starts again automatically
  // if a fresh upload adds a new 'processing' row (the effect re-runs
  // because its id:status dep string just changed).
  useEffect(() => {
    if (!videoMode || !video || !entityId) return;
    const hasProcessing = videoRows.some((v) => v.status === 'processing');
    if (!hasProcessing) return;
    const interval = window.setInterval(() => {
      video
        .pollVideos(entityId)
        .then((fresh) => {
          onVideosChange?.(fresh);
          // The poll returns ROWS, never the entity, so `media` gets the
          // same rows folded into the positions it already holds —
          // otherwise a video that has just become 'ready' appears as a
          // tile only via buildMediaTiles' tail, i.e. at the end of the
          // grid rather than where the server put it. See
          // syncVideosIntoMedia.
          updateMediaFrom((current) => syncVideosIntoMedia(current, fresh));
        })
        .catch(() => {
          // A transient polling failure isn't worth surfacing as an
          // error — the next tick tries again, and the row stays visibly
          // 'processing' in the meantime rather than flashing an alert.
        });
    }, VIDEO_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoMode, entityId, videoRows.map((v) => `${v.id}:${v.status}`).join(',')]);

  // Merges the local pre-server queue with server-tracked non-ready rows
  // into one display list — see VideoQueueItem's own doc for why a
  // successfully-uploaded video moves OUT of local state and into
  // `videos`.
  const displayVideoQueue: Array<VideoQueueItem | { video: VideoItem }> = [
    ...videoQueue,
    ...videoRows.filter((v) => v.status !== 'ready').map((v) => ({ video: v })),
  ];

  return (
    <div className={styles.section}>
      {/* Screen-reader-only feedback for the keyboard move-left/move-right
          path — drag & drop has no equivalent announcement need (a mouse
          user sees the reshuffle happen), but a keyboard/AT user gets no
          other confirmation that a move actually took effect. */}
      <div aria-live="polite" className={styles.srOnly}>
        {announcement}
      </div>

      {tiles.length > 0 && (
        <div className={styles.grid} ref={gridRef}>
          {tiles.map((tile, index) => (
            <div
              key={tileKey(tile)}
              className={styles.mediaTile}
              /* The grid's ORDER made observable. A photo's visible bytes
                 may arrive through an injected `loadImage` (a fetch plus
                 an object URL), so the tile's real identity is NOT
                 readable off `img[src]` — and the aria-labels carry only
                 a position, not an id. Without these two attributes "the
                 video sits between photos 10 and 20" is not a claim any
                 test can make. */
              data-media-kind={tile.kind}
              data-media-id={tile.mediaId}
              draggable
              onDragStart={handleTileDragStart(index)}
              onDragOver={handleTileDragOver}
              onDrop={handleTileDrop(index)}
              onDragEnd={handleTileDragEnd}
            >
              {/* The square, clipped (`overflow: hidden`) box — kept as
                  its own inner element (rather than folding its styles
                  into .mediaTile above) so the size-warning note below
                  can sit BELOW this square as normal-flow content and
                  grow the grid row to fit it, instead of being clipped
                  away by the same overflow:hidden that keeps the
                  poster/photo cropped to a square. */}
              <div className={styles.photo}>
                {tile.kind === 'photo' ? (
                  <>
                    <button
                      type="button"
                      className={styles.editButton}
                      onClick={() => handleOpenCrop(tile.url)}
                      aria-label={t.uploader.editExisting(index + 1, tiles.length)}
                    >
                      <LoadedImage src={tile.url} loadImage={loadImage} alt="" loading="lazy" />
                    </button>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => handleDeleteExisting(tile.url)}
                      disabled={deletingUrl === tile.url}
                      aria-label={t.uploader.removeExisting}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <>
                    <LoadedImage
                      src={tile.video.posterUrl ?? undefined}
                      loadImage={loadImage}
                      alt=""
                      loading="lazy"
                      className={styles.videoPoster}
                    />
                    {/* The play affordance. An inline SVG rather than a
                        text glyph so its size is a real, measurable box
                        that scales with the tile — see .playBadge svg in
                        the CSS module for why the proportion, not the
                        pixel count, is the thing. */}
                    <span className={styles.playBadge} aria-hidden="true">
                      <svg viewBox="0 0 48 48" role="presentation" focusable="false">
                        <circle className={styles.playBadgeDisc} cx="24" cy="24" r="23" />
                        <path className={styles.playBadgeArrow} d="M19 15.5 34 24l-15 8.5z" />
                      </svg>
                    </span>
                    {tile.video.durationMs !== null && (
                      <span className={styles.durationBadge}>{formatDuration(tile.video.durationMs)}</span>
                    )}
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => handleDeleteVideoRow(tile.video)}
                      aria-label={t.uploader.removeExistingVideo}
                    >
                      ×
                    </button>
                  </>
                )}
                <div className={styles.moveButtons}>
                  <button
                    type="button"
                    className={styles.moveButton}
                    onClick={() => handleMoveLeft(index)}
                    disabled={index === 0}
                    aria-label={moveLabel(tile, index + 1, tiles.length, 'left')}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className={styles.moveButton}
                    onClick={() => handleMoveRight(index)}
                    disabled={index === tiles.length - 1}
                    aria-label={moveLabel(tile, index + 1, tiles.length, 'right')}
                  >
                    ›
                  </button>
                </div>
              </div>
              {tile.kind === 'video' &&
                tile.video.byteSize !== null &&
                tile.video.byteSize > limits.sizeWarnBytes &&
                !dismissedWarnings.has(tile.video.id) && (
                  <div className={styles.sizeWarning} role="status">
                    <span>{t.uploader.videoSizeWarning(tile.video.byteSize)}</span>
                    <button type="button" onClick={() => dismissWarning(tile.video.id)}>
                      {t.uploader.videoSizeWarningDismiss}
                    </button>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}

      <label
        className={`${styles.pickLabel} ${dragDepth > 0 ? styles.pickLabelDragging : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragDepth > 0 ? t.uploader.dropzoneActive : t.uploader.dropzoneIdle}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className={styles.fileInput}
          onChange={handleFilesSelected}
        />
      </label>
      <p className={styles.hint}>{t.uploader.hint(Boolean(entityId))}</p>

      {/*
        MUST stay here, immediately after the photo hint and BEFORE the
        video dropzone below. In the origin project this block rendered
        AFTER the video dropzone, so the picker button sat directly under
        the video hint; the owner reasonably read it as the video picker,
        picked a video through it, and got an error. Placing it here keeps
        it unambiguously attached to the photo controls above, and the
        button's own label changes once video support is on, since the
        SAME picker then handles both.
      */}
      {picker.enabled && (
        <div className={styles.googlePhotosRow}>
          <button
            type="button"
            className={styles.googlePhotosButton}
            onClick={() => picker.start()}
            disabled={picker.phase !== 'idle' && picker.phase !== 'error'}
          >
            {picker.phase === 'connecting' && t.googlePhotos.connecting}
            {picker.phase === 'picking' && t.googlePhotos.picking}
            {picker.phase === 'importing' && t.googlePhotos.importing}
            {(picker.phase === 'idle' || picker.phase === 'error') &&
              (videoMode ? t.googlePhotos.pickButtonWithVideo : t.googlePhotos.pickButton)}
          </button>
          {(picker.phase === 'connecting' || picker.phase === 'picking') && (
            <button type="button" className={styles.googlePhotosCancel} onClick={picker.cancel}>
              {t.googlePhotos.cancel}
            </button>
          )}
          {picker.phase === 'error' && picker.error && (
            <p className={styles.googlePhotosError} role="alert">
              {resolveGooglePhotosErrorMessage(picker.error, t.googlePhotos)}
            </p>
          )}
          {picker.imported !== null && (
            <p className={styles.googlePhotosNotice} role="status">
              {t.googlePhotos.importedNotice(picker.imported)}
            </p>
          )}
          {googlePhotosVideoErrors.length > 0 && (
            <div className={styles.googlePhotosError} role="alert">
              {googlePhotosVideoErrors.map((message) => (
                <p key={message} className={styles.googlePhotosVideoErrorItem}>
                  {message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {videoMode && (
        <>
          <label
            className={`${styles.pickLabel} ${videoDragDepth > 0 ? styles.pickLabelDragging : ''}`}
            onDragOver={handleVideoDragOver}
            onDragEnter={handleVideoDragEnter}
            onDragLeave={handleVideoDragLeave}
            onDrop={handleVideoDrop}
          >
            {videoDragDepth > 0 ? t.uploader.videoDropzoneActive : t.uploader.videoDropzoneIdle}
            <input
              ref={videoInputRef}
              type="file"
              accept={limits.acceptedMimeTypes.join(',')}
              multiple
              className={styles.fileInput}
              onChange={handleVideoFilesSelected}
            />
          </label>
          <p className={styles.hint}>
            {t.uploader.videoHint(Boolean(entityId), limits.maxBytes, limits.maxDurationSeconds)}
          </p>
        </>
      )}

      {queue.length > 0 && (
        <div
          className={styles.queue}
          aria-live="polite"
          aria-label={t.uploader.queueRegionLabel(queuedCount, successCount, errorCount)}
        >
          {queue.map((item) => (
            <div key={item.localId} className={styles.queueItem}>
              <div className={styles.queueRow}>
                <LoadedImage src={item.previewUrl} loadImage={loadImage} alt="" className={styles.thumb} />
                <span className={styles.queueName}>{item.fileName}</span>
                <span
                  className={`${styles.queueStatus} ${
                    item.status === 'success'
                      ? styles.statusSuccess
                      : item.status === 'error'
                        ? styles.statusError
                        : styles.statusPending
                  }`}
                >
                  {item.status === 'queued' && t.uploader.queueStatusQueued}
                  {item.status === 'uploading' && t.uploader.queueStatusUploading(item.progress)}
                  {item.status === 'success' && t.uploader.queueStatusSuccess}
                  {item.status === 'error' && t.uploader.queueStatusError}
                </span>
                {/*
                  Editable for 'queued' (nothing uploaded yet — crops
                  purely in memory) and 'error' (the attempt failed, the
                  bytes are still only local — crop, then Retry uploads
                  the NEW bytes since handleRetry reads item.file fresh).
                  Shown but DISABLED for 'uploading' — its bytes are
                  already in flight, so editing now could race the
                  request; disabled and visible (never removed) so the
                  user can see it's temporarily unavailable rather than
                  wondering if it silently disappeared. Hidden for
                  'success' — that photo now lives in the saved grid
                  above with its own, already-working edit button; a
                  second control here would point at a stale local blob
                  preview that may no longer match what the server
                  actually stored.
                */}
                {item.status !== 'success' && (
                  <button
                    type="button"
                    className={styles.queueEditButton}
                    onClick={() => handleOpenCropQueued(item.localId)}
                    disabled={item.status === 'uploading'}
                    aria-label={t.uploader.editQueued(item.fileName)}
                    title={item.status === 'uploading' ? t.uploader.editQueuedUploadingTitle : undefined}
                  >
                    {t.uploader.editButtonText}
                  </button>
                )}
                {item.status === 'queued' && (
                  <button
                    type="button"
                    className={styles.removeQueuedButton}
                    onClick={() => handleRemoveQueued(item.localId)}
                    aria-label={t.uploader.removeQueued(item.fileName)}
                  >
                    ×
                  </button>
                )}
              </div>
              {item.status === 'uploading' && (
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: `${item.progress}%` }} />
                </div>
              )}
              {item.status === 'error' && (
                <>
                  <p className={styles.errorText}>{item.error}</p>
                  <div className={styles.errorActions}>
                    <button type="button" className={styles.retryButton} onClick={() => handleRetry(item)}>
                      {t.uploader.retryButtonText}
                    </button>
                    <button
                      type="button"
                      className={styles.removeQueuedButton}
                      onClick={() => handleRemoveQueued(item.localId)}
                      aria-label={t.uploader.removeQueued(item.fileName)}
                    >
                      {t.uploader.cancelButtonText}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {videoMode && displayVideoQueue.length > 0 && (
        <div className={styles.queue} aria-live="polite" aria-label={t.uploader.videoQueueRegionLabel}>
          {displayVideoQueue.map((entry) => {
            // Local (not-yet-a-server-row) item.
            if ('localId' in entry) {
              const item = entry;
              return (
                <div key={item.localId} className={styles.queueItem}>
                  <div className={styles.queueRow}>
                    <span className={styles.queueName}>{item.fileName}</span>
                    <span
                      className={`${styles.queueStatus} ${
                        item.status === 'error' ? styles.statusError : styles.statusPending
                      }`}
                    >
                      {item.status === 'estimating' && t.uploader.videoStatusEstimating}
                      {item.status === 'confirm-warn' && t.uploader.videoStatusAwaitingConfirmation}
                      {item.status === 'queued' && t.uploader.videoStatusQueued}
                      {item.status === 'uploading' && t.uploader.videoStatusUploading(item.progress)}
                      {item.status === 'error' && t.uploader.videoStatusError}
                    </span>
                  </div>
                  {item.status === 'uploading' && (
                    <div className={styles.progressTrack}>
                      <div className={styles.progressFill} style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                  {item.status === 'confirm-warn' && item.estimateBytes !== undefined && (
                    <>
                      <p className={styles.hint}>{t.uploader.videoSizeConfirmPrompt(item.estimateBytes)}</p>
                      <div className={styles.errorActions}>
                        <button
                          type="button"
                          className={styles.retryButton}
                          onClick={() => handleConfirmVideoWarn(item)}
                        >
                          {t.uploader.videoUploadAnywayText}
                        </button>
                        <button
                          type="button"
                          className={styles.removeQueuedButton}
                          onClick={() => handleCancelVideoQueued(item.localId)}
                        >
                          {t.uploader.cancelButtonText}
                        </button>
                      </div>
                    </>
                  )}
                  {item.status === 'queued' && (
                    <button
                      type="button"
                      className={styles.removeQueuedButton}
                      onClick={() => handleCancelVideoQueued(item.localId)}
                      aria-label={t.uploader.removeQueuedVideo(item.fileName)}
                    >
                      {t.uploader.cancelButtonText}
                    </button>
                  )}
                  {item.status === 'error' && (
                    <>
                      <p className={styles.errorText}>{item.error}</p>
                      <div className={styles.errorActions}>
                        <button
                          type="button"
                          className={styles.retryButton}
                          onClick={() => handleRetryLocalVideo(item)}
                        >
                          {t.uploader.retryButtonText}
                        </button>
                        <button
                          type="button"
                          className={styles.removeQueuedButton}
                          onClick={() => handleCancelVideoQueued(item.localId)}
                        >
                          {t.uploader.cancelButtonText}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            }

            // Server-tracked row still 'processing' or 'failed'.
            const row = entry.video;
            return (
              <div key={row.id} className={styles.queueItem} data-video-id={row.id} data-video-status={row.status}>
                <div className={styles.queueRow}>
                  <span className={styles.queueName}>{t.uploader.videoQueueRowName}</span>
                  <span
                    className={`${styles.queueStatus} ${
                      row.status === 'failed' ? styles.statusError : styles.statusPending
                    }`}
                  >
                    {row.status === 'processing' && t.uploader.videoStatusProcessing}
                    {row.status === 'failed' && t.uploader.videoStatusError}
                  </span>
                </div>
                {row.status === 'failed' && (
                  <>
                    <p className={styles.errorText}>{row.errorMessage}</p>
                    <div className={styles.errorActions}>
                      <button type="button" className={styles.retryButton} onClick={() => handleRetryFailedVideo(row)}>
                        {t.uploader.retryButtonText}
                      </button>
                      <button
                        type="button"
                        className={styles.removeQueuedButton}
                        onClick={() => handleDeleteVideoRow(row)}
                      >
                        {t.uploader.videoDeleteButtonText}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cropTarget && cropImageUrl && (
        <PhotoCropEditor
          imageUrl={cropImageUrl}
          saving={cropSaving}
          onCancel={handleCropCancel}
          onSave={(blob) => void handleCropSave(blob)}
          labels={labels?.cropEditor}
          loadImage={loadImage}
        />
      )}
    </div>
  );
}
