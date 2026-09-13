import { useState } from 'react';
import { PhotoUploader } from '../../../src/components/PhotoUploader';
import type { PhotoApi, UploadResult } from '../../../src/types';

/**
 * Stashed for a spec to decode and check against real pixels, same pattern
 * as CropEditorHarness's `__lastSavedDataUrl`.
 */
interface LastUploadedFile {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

declare global {
  interface Window {
    __lastUploadedFile?: LastUploadedFile;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const NOT_EXERCISED = () => Promise.reject(new Error('not exercised by this harness'));

/**
 * Playwright-only harness — mounts PhotoUploader standalone with fake
 * `PhotoApi` implementations, no backend involved. Two modes, selected by
 * `?unsaved=1`:
 *
 *   - DEFAULT (no query param): entityId="1" with five fixed photos,
 *     upload/replace/delete all rejecting — exists for exactly one thing:
 *     the "focus survives a keyboard reorder" spec. PhotoUploader.tsx's
 *     `pendingFocusRef` comment documents a real-Chromium-only finding
 *     (relocating a focused tile's DOM node via React's `key={url}`
 *     reconciliation does not by itself blur it, but Chromium DOES
 *     auto-blur a focused element the instant it becomes `disabled`, which
 *     the LAST move in a sequence does) — JSDOM implements neither
 *     behaviour, so nothing in test/PhotoUploader.test.tsx can observe it
 *     either way. Five photos so a full sequence of four rightward
 *     keyboard moves (position 1 -> 5) can be driven end to end, including
 *     the last move that disables the just-pressed button.
 *
 *   - UNSAVED (`?unsaved=1`): entityId starts `null` (mirrors a brand-new
 *     form before its first save), no saved photos, an `uploadPhoto` fake
 *     that actually "succeeds" (records the uploaded File's real bytes on
 *     `window.__lastUploadedFile`), and a "Save (test)" button that flips
 *     `entityId` to `"1"` — the same transition a real consumer triggers by
 *     saving the owning entity for the first time, which is what
 *     PhotoUploader's own effect reacts to by uploading everything still
 *     queued.
 */
export function PhotoUploaderHarness() {
  const params = new URLSearchParams(window.location.search);
  const unsaved = params.get('unsaved') === '1';

  const [entityId, setEntityId] = useState<string | null>(unsaved ? null : '1');
  const [urls, setUrls] = useState<string[]>(
    unsaved
      ? []
      : ['/images/10', '/images/20', '/images/30', '/images/40', '/images/50'],
  );

  async function fakeUploadPhoto(id: string, file: File, onProgress: (percent: number) => void): Promise<UploadResult> {
    const dataUrl = await blobToDataUrl(file);
    window.__lastUploadedFile = { name: file.name, type: file.type, size: file.size, dataUrl };
    onProgress(100);
    const newUrl = `/images/${Date.now()}`;
    return { fileName: file.name, status: 'success', imageUrls: [newUrl] };
  }

  const api: PhotoApi = {
    uploadPhoto: unsaved ? fakeUploadPhoto : NOT_EXERCISED,
    deleteImage: NOT_EXERCISED,
    reorderImages: (_entityId, ids) =>
      // A real backend would return the fresh server-canonical order —
      // this fake just echoes back what the component already applied
      // optimistically, since only reorder/focus behaviour is under test
      // by the default-mode harness.
      Promise.resolve({ imageUrls: ids.map((id) => `/images/${id}`) }),
    replaceImage: NOT_EXERCISED,
  };

  return (
    <div>
      <PhotoUploader entityId={entityId} imageUrls={urls} onImageUrlsChange={setUrls} api={api} />
      {unsaved && (
        <button type="button" onClick={() => setEntityId('1')}>
          Save (test)
        </button>
      )}
    </div>
  );
}
