import type { ImageUrlsResult, PhotoApi, UploadResult } from 'react-photoblock';

/**
 * An entirely in-memory, in-browser stand-in for a real backend implementing
 * docs/server-contract.md — no network calls, nothing persisted past a page
 * reload. This is what proves PhotoUploader's dependency-injection design
 * actually works: nothing in the package itself knows or cares that this
 * "server" is fake.
 *
 * DEMO-ONLY PLUMBING: PhotoUploader recovers an image's id by parsing its
 * URL for a trailing `/images/<id>` segment (see the real package's own
 * `extractImageId` — that shape is the one hard assumption a real backend
 * has to honor, see docs/server-contract.md). A real backend serves actual
 * HTTP URLs shaped that way. This fake has no server to serve anything
 * from, so it appends `#/images/<id>` as a URL FRAGMENT onto a real
 * `URL.createObjectURL(...)` blob URL — browsers ignore the fragment when
 * resolving which blob to load, but it still gives `extractImageId` the
 * exact path shape it's looking for. Do not copy this fragment trick into
 * a real backend; it exists only because this example has no server to
 * route `/images/<id>` to.
 */
export function createFakeApi(): PhotoApi {
  let nextId = 1;
  const store = new Map<string, { entityId: string; blobUrl: string }>();

  function urlsFor(entityId: string): string[] {
    return [...store.entries()]
      .filter(([, row]) => row.entityId === entityId)
      .map(([id, row]) => `${row.blobUrl}#/images/${id}`);
  }

  return {
    async uploadPhoto(entityId, file, onProgress) {
      // Fake a bit of network latency and progress, since a real upload
      // would report it — nothing here should be read as "how to do
      // progress reporting for real"; that's XHR's upload.onprogress
      // against a real request.
      for (const percent of [20, 55, 90, 100]) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 120));
        onProgress(percent);
      }
      const id = String(nextId++);
      store.set(id, { entityId, blobUrl: URL.createObjectURL(file) });
      return { fileName: file.name, status: 'success', imageUrls: urlsFor(entityId) } satisfies UploadResult;
    },

    async deleteImage(entityId, imageId) {
      store.delete(imageId);
    },

    async reorderImages(entityId, imageIds): Promise<ImageUrlsResult> {
      // A real backend would persist sort_order here (see
      // docs/server-contract.md) — this fake has no ordering column at
      // all, so it just re-derives the URL list in the order the caller
      // asked for.
      return { imageUrls: imageIds.map((id) => `${store.get(id)!.blobUrl}#/images/${id}`) };
    },

    async replaceImage(entityId, imageId, file): Promise<ImageUrlsResult> {
      const existing = store.get(imageId);
      if (!existing) throw new Error('Photo not found');
      // A real backend bumps updated_at and folds it into a `?v=` query
      // token here (see docs/server-contract.md's "replace in place"
      // section) — this fake gets the same cache-busting effect for free
      // because URL.createObjectURL hands back a brand new URL every call.
      existing.blobUrl = URL.createObjectURL(file);
      return { imageUrls: urlsFor(existing.entityId) };
    },
  };
}
