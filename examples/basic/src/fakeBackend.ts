import type {
  ImageUrlsResult,
  MediaItem,
  PhotoApi,
  UploadResult,
  VideoApi,
  VideoItem,
} from 'react-mediablock';

/**
 * An entirely in-memory, in-browser stand-in for a real backend
 * implementing docs/server-contract.md — no network calls, nothing
 * persisted past a page reload. This is what proves the package's
 * dependency-injection design actually works: nothing in the package knows
 * or cares that this "server" is fake.
 *
 * Photos and videos live in ONE object on purpose. They share a single
 * `sortOrder` numbering space, the combined `media` order is merged here
 * and only here, and `reorderMedia` has to validate across both — none of
 * which is expressible if the two fakes cannot see each other. See
 * docs/server-contract.md §8.
 *
 * NO REAL TRANSCODE HAPPENS HERE, and that is the honest shape of the
 * design rather than a shortcut: transcoding is the server's job, so a fake
 * server has a fake transcode. What this file DOES reproduce faithfully is
 * the part a consumer gets wrong — see `uploadVideo` below.
 *
 * DEMO-ONLY PLUMBING: the package recovers an image's id by parsing its URL
 * for a trailing `/images/<id>` segment (see its own `extractImageId` —
 * that shape is the one hard assumption a real backend has to honour). A
 * real backend serves actual HTTP URLs shaped that way. This fake has no
 * server to serve anything from, so it appends `#/images/<id>` as a URL
 * FRAGMENT onto a real `URL.createObjectURL(...)` blob URL — browsers
 * ignore the fragment when resolving which blob to load, but it still gives
 * the parser the exact path shape it looks for. Do not copy this fragment
 * trick into a real backend.
 */

/** Gap between successive positions, so an insert-between needs no full
 *  renumber. Same convention §3 recommends. */
const SORT_STEP = 10;

/** How long the fake "transcode" takes. Short enough to watch; a real one
 *  runs at roughly 0.4x realtime, i.e. seconds to minutes. */
const FAKE_TRANSCODE_MS = 3000;

interface PhotoRow {
  entityId: string;
  blobUrl: string;
  sortOrder: number;
  createdAt: number;
}

interface VideoRow {
  entityId: string;
  status: VideoItem['status'];
  sortOrder: number;
  createdAt: number;
  posterUrl: string | null;
  videoUrl: string | null;
  durationMs: number | null;
  byteSize: number | null;
  errorMessage: string | null;
}

/**
 * A poster drawn rather than extracted. This fake cannot decode a video
 * frame, and pretending otherwise would be the one part of this example
 * that actively misleads — a real server extracts a real frame.
 */
function fakePosterUrl(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
    <rect width="320" height="320" fill="#243b53"/>
    <text x="160" y="150" font-family="system-ui" font-size="22" fill="#cbd5e1" text-anchor="middle">fake poster</text>
    <text x="160" y="182" font-family="system-ui" font-size="15" fill="#8ba3bf" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface FakeBackend {
  api: PhotoApi;
  video: VideoApi;
  /** The entity's current photo URLs, in stored order. */
  imageUrls: (entityId: string) => string[];
  /** The entity's videos, EVERY status — see §7. */
  videos: (entityId: string) => VideoItem[];
  /** The combined order. Merged here, server-side and only server-side. */
  media: (entityId: string) => MediaItem[];
}

export function createFakeBackend(): FakeBackend {
  let nextPhotoId = 1;
  let nextVideoId = 1;
  let uploadCount = 0;
  const photos = new Map<string, PhotoRow>();
  const videos = new Map<string, VideoRow>();

  /** A new row appends past the maximum across BOTH kinds — §8's shared
   *  numbering space. Taking the max of only one table is how a new photo
   *  ends up handed an existing video's position. */
  function nextSortOrder(entityId: string): number {
    let max = 0;
    for (const row of photos.values()) if (row.entityId === entityId) max = Math.max(max, row.sortOrder);
    for (const row of videos.values()) if (row.entityId === entityId) max = Math.max(max, row.sortOrder);
    return max + SORT_STEP;
  }

  function photoUrl(id: string): string {
    return `${photos.get(id)!.blobUrl}#/images/${id}`;
  }

  function photoIds(entityId: string): string[] {
    return [...photos.entries()]
      .filter(([, row]) => row.entityId === entityId)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[1].createdAt - b[1].createdAt || Number(a[0]) - Number(b[0]))
      .map(([id]) => id);
  }

  function imageUrls(entityId: string): string[] {
    return photoIds(entityId).map(photoUrl);
  }

  function videoDto(id: string, row: VideoRow): VideoItem {
    return {
      id,
      status: row.status,
      errorMessage: row.errorMessage,
      posterUrl: row.posterUrl,
      videoUrl: row.videoUrl,
      durationMs: row.durationMs,
      byteSize: row.byteSize,
      width: row.status === 'ready' ? 1280 : null,
      height: row.status === 'ready' ? 720 : null,
    };
  }

  function videoEntries(entityId: string): Array<[string, VideoRow]> {
    return [...videos.entries()]
      .filter(([, row]) => row.entityId === entityId)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[1].createdAt - b[1].createdAt || Number(a[0]) - Number(b[0]));
  }

  function videoList(entityId: string): VideoItem[] {
    return videoEntries(entityId).map(([id, row]) => videoDto(id, row));
  }

  /**
   * THE MERGE: one `sortOrder` space across both kinds, tie-broken by
   * `createdAt`, then photo-before-video, then id. §8 explains why every
   * clause is load-bearing and why no client may re-derive this.
   */
  function media(entityId: string): MediaItem[] {
    const KIND_RANK = { image: 0, video: 1 } as const;
    const tagged = [
      ...photoIds(entityId).map((id) => {
        const row = photos.get(id)!;
        return {
          kind: 'image' as const,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt,
          numericId: Number(id),
          item: { type: 'image' as const, id, url: photoUrl(id), sortOrder: row.sortOrder },
        };
      }),
      ...videoEntries(entityId).map(([id, row]) => ({
        kind: 'video' as const,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        numericId: Number(id),
        item: { ...videoDto(id, row), type: 'video' as const, sortOrder: row.sortOrder },
      })),
    ];
    tagged.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.createdAt - b.createdAt ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.numericId - b.numericId,
    );
    return tagged.map((entry) => entry.item);
  }

  const api: PhotoApi = {
    async uploadPhoto(entityId, file, onProgress) {
      // Fake a bit of latency and progress, since a real upload would
      // report it — nothing here should be read as "how to do progress
      // reporting for real"; that's XHR's upload.onprogress.
      for (const percent of [20, 55, 90, 100]) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 120));
        onProgress(percent);
      }
      const id = String(nextPhotoId++);
      photos.set(id, {
        entityId,
        blobUrl: URL.createObjectURL(file),
        sortOrder: nextSortOrder(entityId),
        createdAt: Date.now(),
      });
      // `media` travels with the response — §9. Returning only imageUrls
      // is what left a freshly uploaded photo in the wrong place.
      return {
        fileName: file.name,
        status: 'success',
        imageUrls: imageUrls(entityId),
        media: media(entityId),
      } satisfies UploadResult;
    },

    async deleteImage(_entityId, imageId) {
      // No body in the response — the package drops the entry itself.
      photos.delete(imageId);
    },

    async reorderImages(entityId, imageIds): Promise<ImageUrlsResult> {
      // The photo-only path, used when no VideoApi is injected.
      imageIds.forEach((id, index) => {
        const row = photos.get(id);
        if (row) photos.set(id, { ...row, sortOrder: (index + 1) * SORT_STEP });
      });
      return { imageUrls: imageUrls(entityId), media: media(entityId) };
    },

    async replaceImage(entityId, imageId, file): Promise<ImageUrlsResult> {
      const existing = photos.get(imageId);
      if (!existing) throw new Error('Photo not found');
      // A real backend bumps updated_at and folds it into a `?v=` token
      // here (§4) — this fake gets the same cache-busting effect for free,
      // because createObjectURL hands back a brand new URL every call. The
      // id and the position are deliberately unchanged.
      photos.set(imageId, { ...existing, blobUrl: URL.createObjectURL(file) });
      return { imageUrls: imageUrls(entityId), media: media(entityId) };
    },
  };

  const video: VideoApi = {
    async uploadVideo(entityId, file, onProgress) {
      for (const percent of [25, 60, 90, 100]) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 100));
        onProgress(percent);
      }
      const id = String(nextVideoId++);
      uploadCount += 1;
      // Every 7th upload "fails", so the failed-row UI is reachable in the
      // demo rather than being a code path nobody ever sees.
      const willFail = uploadCount % 7 === 0;
      const row: VideoRow = {
        entityId,
        status: 'processing',
        sortOrder: nextSortOrder(entityId),
        createdAt: Date.now(),
        // NULL until ready. This is exactly why the package does not make
        // a grid tile of it yet — there is no poster to show.
        posterUrl: null,
        videoUrl: null,
        durationMs: null,
        byteSize: null,
        errorMessage: null,
      };
      videos.set(id, row);

      // The "transcode", on its own clock, long after this call returned.
      // An upload that waited for it would be a seven-minute request for a
      // three-minute clip.
      setTimeout(() => {
        const current = videos.get(id);
        if (!current) return; // deleted while "transcoding" — a real case
        if (willFail) {
          // A 'failed' row must carry a reason, and that reason is shown
          // verbatim to whoever uploaded the file.
          videos.set(id, { ...current, status: 'failed', errorMessage: 'demo: every 7th upload fails on purpose' });
          return;
        }
        videos.set(id, {
          ...current,
          status: 'ready',
          posterUrl: fakePosterUrl(file.name),
          videoUrl: URL.createObjectURL(file),
          durationMs: 65_000,
          byteSize: file.size,
        });
      }, FAKE_TRANSCODE_MS);

      // Answers IMMEDIATELY with the 'processing' row — §6.
      return { fileName: file.name, status: 'success', video: videoDto(id, row) };
    },

    async deleteVideo(_entityId, videoId) {
      videos.delete(videoId);
    },

    // Every video, every status. That is what the poll is for — §7.
    async pollVideos(entityId) {
      return videoList(entityId);
    },

    async reorderMedia(entityId, items) {
      const currentPhotos = new Set(photoIds(entityId));
      const currentReadyVideos = new Set(
        videoEntries(entityId)
          .filter(([, row]) => row.status === 'ready')
          .map(([id]) => id),
      );
      const nonReady = videoEntries(entityId).filter(([, row]) => row.status !== 'ready');

      const requestedPhotos = items.filter((item) => item.type === 'image').map((item) => item.id);
      const requestedVideos = items.filter((item) => item.type === 'video').map((item) => item.id);

      // MEMBERSHIP, at full strength: no foreign ids, no duplicates. In a
      // real backend this is a security boundary, so the example does not
      // model it as optional.
      const matchesExactly = (requested: string[], current: Set<string>) =>
        requested.length === current.size &&
        new Set(requested).size === requested.length &&
        requested.every((id) => current.has(id));

      // COMPLETENESS, against photos + READY videos — NOT all videos. The
      // grid never shows a non-ready row, so it cannot submit one;
      // demanding it rejects every reorder while a clip transcodes, which
      // is the bug §8 is written around.
      if (!matchesExactly(requestedPhotos, currentPhotos) || !matchesExactly(requestedVideos, currentReadyVideos)) {
        throw new Error('media order mismatch');
      }

      items.forEach((item, index) => {
        const sortOrder = (index + 1) * SORT_STEP;
        if (item.type === 'image') {
          const row = photos.get(item.id);
          if (row) photos.set(item.id, { ...row, sortOrder });
        } else {
          const row = videos.get(item.id);
          if (row) videos.set(item.id, { ...row, sortOrder });
        }
      });

      // THE NON-READY TAIL: after every submitted item, keeping their own
      // order. The loop above rewrote positions 10..n*10, and a non-ready
      // video still holds whatever the append gave it — which can now
      // collide with that range. A tie then resolves on a timestamp nobody
      // can see or change, so the clip would surface at an unpredictable
      // spot when it finished.
      nonReady.forEach(([id, row], index) => {
        videos.set(id, { ...row, sortOrder: (items.length + index + 1) * SORT_STEP });
      });

      return { imageUrls: imageUrls(entityId), videos: videoList(entityId), media: media(entityId) };
    },
  };

  return { api, video, imageUrls, videos: videoList, media };
}
