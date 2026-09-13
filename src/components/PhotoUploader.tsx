import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { useGooglePhotosPicker, resolveGooglePhotosErrorMessage } from '../googlePhotos/useGooglePhotosPicker';
import { mergeLabels } from '../labels';
import type { DeepPartial, PhotoBlockLabels } from '../labels';
import { PhotoCropEditor } from './PhotoCropEditor';
import type { GooglePhotosAdapter, PhotoApi } from '../types';
import styles from './PhotoUploader.module.css';

export interface PhotoUploaderProps {
  /** Null before the owning entity has ever been saved — see the module doc below. */
  entityId: string | null;
  imageUrls: string[];
  onImageUrlsChange: (urls: string[]) => void;
  /** Fires whenever the queue changes. `pending` is true while anything is
   *  still queued or uploading; `hasErrors` is true if any item finished
   *  badly. A typical use is to hold off leaving the page until uploads
   *  have actually landed — and to NOT leave at all if one failed, so the
   *  user can see and retry it rather than losing a silently missing
   *  photo. */
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
  labels?: DeepPartial<PhotoBlockLabels>;
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
 * Every image URL a `PhotoApi` implementation returns is expected to end
 * in `/images/<id>`, optionally followed by a query string (e.g. a
 * `?v=<version>` cache-busting token — see docs/server-contract.md's
 * "replace in place" section for why that matters). This is the one
 * place this component parses that shape back out, to recover the
 * numeric/opaque id a delete/replace call needs.
 */
function extractImageId(url: string): string | null {
  const match = /\/images\/([^/?]+)(?:\?.*)?$/.exec(url);
  return match ? match[1]! : null;
}

let uidCounter = 0;
function nextLocalId(): string {
  uidCounter += 1;
  return `upload-${uidCounter}`;
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
 * What's open in the crop editor: either an EXISTING, already-uploaded
 * photo (`imageId` resolves against the entity's real image set, replaced
 * in place via `api.replaceImage` — the original, only path) or a QUEUED
 * one that has never touched the server (`localId` resolves against
 * `queue`, cropped purely in memory — see handleCropSave's 'queued'
 * branch below). The two need different data to open (a server imageId
 * vs a local queue id) and different save behaviour, so this is a
 * discriminated union rather than trying to force one shape to cover
 * both.
 */
type CropTarget = { type: 'existing'; url: string; imageId: string } | { type: 'queued'; localId: string };

/**
 * Multi-photo picker + uploader: pick/drag files, watch them upload with
 * per-file progress, reorder by drag or keyboard, click any photo to
 * crop/rotate it, delete, and (optionally) import from Google Photos.
 * All server interaction is injected via the `api` prop — see `PhotoApi`
 * in src/types.ts — so this component has no fetch, no HTTP client, and
 * no opinion about your backend's URL scheme beyond the `/images/<id>`
 * shape `extractImageId` parses back out of the URLs you hand it.
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
 */
export function PhotoUploader({
  entityId,
  imageUrls,
  onImageUrlsChange,
  onQueueStateChange,
  api,
  googlePhotos,
  labels,
}: PhotoUploaderProps) {
  const t = mergeLabels(labels);

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
  // A keyboard move-left/move-right re-sorts `imageUrls`, and React's
  // `key={url}` reconciliation relocates that tile's DOM node to its new
  // position in the grid. In a real browser, relocating a focused element
  // does NOT by itself blur it — but the fourth move can land the photo
  // at the LAST index, which makes that same, still-focused button
  // `disabled` (see the grid's `disabled={index === imageUrls.length - 1}`
  // below), and disabling a focused element does blur it to <body> in
  // every evergreen browser, same as clicking a plain `disabled` toggle
  // would. So the fix is an explicit refocus after the move, not merely
  // avoiding a disabled-state change. `pendingFocusRef` records which
  // photo/direction requested a move; the effect below finds that SAME
  // photo's new index once `imageUrls` (a prop) actually updates, and
  // refocuses its move button there — same direction if still enabled
  // (so a keyboard user can keep pressing to keep moving it), else the
  // opposite direction, else the tile's edit button as a last resort.
  // NOTE: JSDOM has no real focus-management engine, so this specific
  // loss-of-focus failure mode cannot be reproduced or asserted against
  // in a JSDOM test at all — only the effect's own wiring (does it call
  // `.focus()` on the right element) can be. See the README's
  // Limitations section.
  const pendingFocusRef = useRef<{ imageId: string; direction: 'left' | 'right' } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Click-to-crop: which photo (if any) is open in the editor — see
  // CropTarget's own doc for why this covers both an existing, uploaded
  // photo and a still-queued one.
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const [cropSaving, setCropSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const prevEntityIdRef = useRef<string | null>(entityId);

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

  // Revoke every preview URL still alive when this component unmounts —
  // otherwise each picked photo leaks its object URL for the life of the tab.
  useEffect(() => {
    return () => {
      queueRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    };
  }, []);

  // handleFiles is a hoisted function declaration (defined further below
  // in this component) — safe to reference here regardless of source
  // order. The hook is ALWAYS called (React's rules of hooks forbid
  // calling it conditionally); when `googlePhotos` is undefined, the hook
  // itself is inert (`enabled: false`, no timers/listeners) — see its own
  // doc. handleFiles is a plain function recreated every render, but the
  // hook only ever reads the LATEST one via its own internal ref, so a
  // fresh closure here is never a reason for it to tear down and recreate
  // anything.
  const picker = useGooglePhotosPicker({ adapter: googlePhotos, onPhotosReady: (files) => handleFiles(files) });

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
      } else {
        updateItem(item.localId, { status: 'error', error: result.error });
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, onImageUrlsChange],
  );

  // The moment `entityId` first becomes real (the entity's first save just
  // happened), upload everything that was queued while it was still null.
  useEffect(() => {
    const previous = prevEntityIdRef.current;
    prevEntityIdRef.current = entityId;
    if (previous || !entityId) return;

    const stillQueued = queueRef.current.filter((item) => item.status === 'queued');
    if (stillQueued.length === 0) return;

    (async () => {
      // Sequential, not Promise.all — see module doc.
      for (const item of stillQueued) {
        // eslint-disable-next-line no-await-in-loop
        await uploadOne(entityId, item);
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
      localId: nextLocalId(),
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

  /**
   * Shared by drag & drop and the keyboard move buttons: applies a new
   * order, optimistically (so the UI reshuffles instantly), then confirms
   * it with the server — reverting back to the previous order and
   * alerting if the request fails, same failure-handling shape as
   * handleDeleteExisting below.
   */
  async function reorderTo(newUrls: string[], announceText: string) {
    if (!entityId) return;
    const previous = imageUrls;
    onImageUrlsChange(newUrls);
    setAnnouncement(announceText);
    reorderInFlightRef.current = true;
    const ids = newUrls.map(extractImageId).filter((id): id is string => id !== null);
    try {
      const result = await api.reorderImages(entityId, ids);
      if (result.imageUrls) onImageUrlsChange(result.imageUrls);
    } catch (err) {
      onImageUrlsChange(previous);
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
   * wherever it already was, so unconditionally refocusing a 20px arrow
   * button after the drop would steal focus from whatever the mouse
   * cursor was actually doing next.
   */
  function moveOne(fromIndex: number, toIndex: number, direction: 'left' | 'right', source: 'keyboard' | 'pointer' = 'keyboard') {
    if (toIndex < 0 || toIndex >= imageUrls.length || fromIndex === toIndex) return;
    if (reorderInFlightRef.current) return;
    if (source === 'keyboard') {
      const movedImageId = extractImageId(imageUrls[fromIndex] ?? '');
      if (movedImageId) pendingFocusRef.current = { imageId: movedImageId, direction };
    }
    const next = [...imageUrls];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    // Names the FROM and TO positions — not the photo's database id
    // (meaningless to a screen-reader user) — so two different moves that
    // happen to land on the same destination (e.g. 1→2, then later 3→2)
    // still read as distinguishable sentences instead of an identical one
    // twice.
    void reorderTo(next, t.uploader.moveAnnouncement(fromIndex + 1, toIndex + 1, imageUrls.length));
  }

  /**
   * Refocuses the moved photo's move button once the DOM has actually
   * relocated it (see pendingFocusRef's comment above) — depends on
   * `imageUrls` (the prop), which only takes on its new order after the
   * consumer re-renders with the value `onImageUrlsChange` handed it.
   */
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const newIndex = imageUrls.findIndex((url) => extractImageId(url) === pending.imageId);
    if (newIndex === -1 || !gridRef.current) return;
    const total = imageUrls.length;
    const sameDirLabel =
      pending.direction === 'left' ? t.uploader.moveLeft(newIndex + 1, total) : t.uploader.moveRight(newIndex + 1, total);
    const otherDirLabel =
      pending.direction === 'left' ? t.uploader.moveRight(newIndex + 1, total) : t.uploader.moveLeft(newIndex + 1, total);
    const editLabel = t.uploader.editExisting(newIndex + 1, total);
    const target =
      gridRef.current.querySelector<HTMLButtonElement>(`button[aria-label="${sameDirLabel}"]:not(:disabled)`) ??
      gridRef.current.querySelector<HTMLButtonElement>(`button[aria-label="${otherDirLabel}"]:not(:disabled)`) ??
      gridRef.current.querySelector<HTMLButtonElement>(`button[aria-label="${editLabel}"]`);
    target?.focus();
    // Only ever needs to react to imageUrls actually changing — pending
    // is read fresh from the ref each run, not a reactive dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrls]);

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
      // refocus effect — see moveOne's own comment. The 'right'/'left'
      // direction argument is still harmless either way (it only ever
      // mattered for the focus label this drag deliberately skips), so
      // it's kept only for a consistent announcement string.
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

  return (
    <div className={styles.section}>
      {/* Screen-reader-only feedback for the keyboard move-left/move-right
          path — drag & drop has no equivalent announcement need (a mouse
          user sees the reshuffle happen), but a keyboard/AT user gets no
          other confirmation that a move actually took effect. */}
      <div aria-live="polite" className={styles.srOnly}>
        {announcement}
      </div>

      {imageUrls.length > 0 && (
        <div className={styles.grid} ref={gridRef}>
          {imageUrls.map((url, index) => (
            <div
              key={url}
              className={styles.photo}
              draggable
              onDragStart={handleTileDragStart(index)}
              onDragOver={handleTileDragOver}
              onDrop={handleTileDrop(index)}
              onDragEnd={handleTileDragEnd}
            >
              <button
                type="button"
                className={styles.editButton}
                onClick={() => handleOpenCrop(url)}
                aria-label={t.uploader.editExisting(index + 1, imageUrls.length)}
              >
                <img src={url} alt="" loading="lazy" />
              </button>
              <button
                type="button"
                className={styles.removeButton}
                onClick={() => handleDeleteExisting(url)}
                disabled={deletingUrl === url}
                aria-label={t.uploader.removeExisting}
              >
                ×
              </button>
              <div className={styles.moveButtons}>
                <button
                  type="button"
                  className={styles.moveButton}
                  onClick={() => handleMoveLeft(index)}
                  disabled={index === 0}
                  aria-label={t.uploader.moveLeft(index + 1, imageUrls.length)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className={styles.moveButton}
                  onClick={() => handleMoveRight(index)}
                  disabled={index === imageUrls.length - 1}
                  aria-label={t.uploader.moveRight(index + 1, imageUrls.length)}
                >
                  ›
                </button>
              </div>
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
            {(picker.phase === 'idle' || picker.phase === 'error') && t.googlePhotos.pickButton}
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
          {picker.importedCount !== null && (
            <p className={styles.googlePhotosNotice} role="status">
              {t.googlePhotos.importedNotice(picker.importedCount)}
            </p>
          )}
        </div>
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
                <img src={item.previewUrl} alt="" className={styles.thumb} />
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

      {cropTarget && cropImageUrl && (
        <PhotoCropEditor
          imageUrl={cropImageUrl}
          saving={cropSaving}
          onCancel={handleCropCancel}
          onSave={(blob) => void handleCropSave(blob)}
          labels={labels?.cropEditor}
        />
      )}
    </div>
  );
}
