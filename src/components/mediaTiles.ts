import type { MediaItem, MediaOrderItem, VideoItem } from '../types';

/**
 * One tile in the combined photo+video grid — either an existing photo or
 * a READY video.
 *
 * A 'processing' or 'failed' video is deliberately NOT a tile: its poster
 * does not exist until the transcode finishes (`VideoItem.posterUrl` is
 * null before then), so it has no image to show, and it lives in
 * MediaUploader's separate video queue panel instead. A blank square in
 * the mosaic would not be an improvement.
 *
 * `mediaId` is what a combined reorder submits per item (see
 * `tilesToMediaOrder`).
 */
export type MediaTile =
  | { kind: 'photo'; url: string; mediaId: string }
  | { kind: 'video'; video: VideoItem; mediaId: string };

/**
 * Every image URL handed to this package is expected to end in
 * `/images/<id>`, optionally followed by a query string (typically a
 * `?v=<version>` cache-busting token — see docs/server-contract.md's
 * "replace in place" section for why that token has to be there). This is
 * the one place that parses that shape back out, to recover the opaque id
 * a delete/replace/reorder call needs.
 *
 * The trailing `(?:\?.*)?` is what tolerates the version token, so this
 * recovers the same id regardless of which version of the URL it is given.
 */
export function extractImageId(url: string): string | null {
  const match = /\/images\/([^/?]+)(?:\?.*)?$/.exec(url);
  return match ? match[1]! : null;
}

/**
 * Photo ids and video ids come from two DIFFERENT sources (two tables, in
 * every backend shaped like the reference one), so `"10"` is a perfectly
 * possible id for both at once. Every lookup between a tile and a `media`
 * entry is therefore keyed on kind AND id — keying on the bare id would
 * silently match a photo against a video and reorder the wrong thing.
 */
export function mediaTileKey(tile: MediaTile): string {
  return `${tile.kind}:${tile.mediaId}`;
}

/** The same namespaced key for a server `media` entry — see mediaTileKey. */
export function mediaItemKey(item: MediaItem): string {
  return `${item.type === 'image' ? 'photo' : 'video'}:${item.id}`;
}

export interface BuildMediaTilesInput {
  /** The entity's photos, in the order the server listed them. */
  imageUrls: string[];
  /** The entity's videos, EVERY status — non-ready ones are filtered out here. */
  videos: VideoItem[];
  /**
   * The server's single ordered media list. Absent on a consumer that
   * does not supply one, which falls back to photos-then-videos.
   */
  media?: MediaItem[];
  /** False when no `VideoApi` was injected — videos then never become tiles. */
  videoMode: boolean;
}

/**
 * Builds the grid's tiles. `media` is the ORDER authority; `imageUrls` and
 * `videos` stay the CONTENT authority.
 *
 * THAT SPLIT IS THE WHOLE POINT, and it is what makes a moved video stick.
 * Before it existed, the grid derived "photos in order, then videos in
 * order", because `imageUrls: string[]` carries no position at all — so no
 * arrangement in which a video sat between two photos was even
 * representable. The arrows fired, the server stored the new order, and
 * the response re-derived the same photos-then-videos list and snapped the
 * tile straight back. Honouring `media`'s ARRAY ORDER fixes that without
 * re-implementing the merge rule client-side: two clients re-deriving
 * `(sort_order, created_at, id)` with photo-first tie-breaking would
 * drift, so `sortOrder` is carried on the type but deliberately not sorted
 * on here (see docs/server-contract.md §8).
 *
 * Content still comes from `imageUrls`/`videos` because they are fresher
 * than `media` between round trips. Four concrete ways:
 *   - a photo UPLOAD may return only `imageUrls`, and a video upload only
 *     its own new row — neither necessarily returns `media`. Those land in
 *     the unknown tail below, i.e. at the end of the grid.
 *   - a CROP returns a fresh `?v=` token on the SAME image id; taking the
 *     url from `imageUrls` is what makes the new bytes visible immediately
 *     even though `media` still holds the old url.
 *   - a DELETE removes the row from `imageUrls`/`videos`; anything `media`
 *     still lists but they no longer do is dropped.
 *   - POLLING moves a video 'processing' -> 'ready' in `videos`; taking
 *     the row from there is what lets it appear as a tile at its stored
 *     position without waiting for a new `media` payload.
 */
export function buildMediaTiles({ imageUrls, videos, media, videoMode }: BuildMediaTilesInput): MediaTile[] {
  const photoTiles: MediaTile[] = imageUrls.map((url) => ({
    kind: 'photo',
    url,
    mediaId: extractImageId(url) ?? url,
  }));
  const videoTiles: MediaTile[] = videoMode
    ? videos.filter((video) => video.status === 'ready').map((video) => ({ kind: 'video', video, mediaId: video.id }))
    : [];

  // The pre-`media` arrangement, kept verbatim as the fallback so a
  // consumer that supplies no `media` behaves byte-for-byte as this
  // component did before video existed.
  const fallback: MediaTile[] = [...photoTiles, ...videoTiles];
  if (!media) return fallback;

  const byKey = new Map<string, MediaTile>(fallback.map((tile) => [mediaTileKey(tile), tile]));
  const taken = new Set<string>();
  const ordered: MediaTile[] = [];

  for (const item of media) {
    const key = mediaItemKey(item);
    const tile = byKey.get(key);
    // No tile means either a row that has since been deleted, or a video
    // that is not 'ready' (and so belongs in the queue panel, not here) —
    // both are correctly skipped. `taken` guards against a duplicated
    // entry rendering the same tile twice with the same React key.
    if (!tile || taken.has(key)) continue;
    taken.add(key);
    ordered.push(tile);
  }

  // Anything `media` does not mention yet — see the doc above for the four
  // ways that happens. Appended in fallback order (photos, then videos),
  // which is where a freshly uploaded item already appeared.
  for (const tile of fallback) {
    const key = mediaTileKey(tile);
    if (taken.has(key)) continue;
    taken.add(key);
    ordered.push(tile);
  }

  return ordered;
}

/**
 * Projects a tile order into the reorder REQUEST payload.
 *
 * Because tiles are built by `buildMediaTiles`, which filters videos to
 * `status === 'ready'`, this payload structurally cannot contain a
 * non-ready video. That is not a detail — it is half of the contract in
 * docs/server-contract.md §8. The server's completeness check must
 * validate against photos + READY videos for exactly this reason; the
 * origin project validated against ALL videos and therefore rejected
 * EVERY reorder while any clip was still transcoding, which can be
 * minutes. Membership (no foreign ids, no duplicates) stays at full
 * strength on the server either way — that part is a security boundary.
 */
export function tilesToMediaOrder(tiles: MediaTile[]): MediaOrderItem[] {
  return tiles.map((tile) => ({ type: tile.kind === 'photo' ? 'image' : 'video', id: tile.mediaId }));
}

/**
 * Projects a tile order back into a `media` array, for the OPTIMISTIC
 * update a reorder applies before the server confirms it. Without this the
 * grid would reshuffle for one frame and then snap back the moment the
 * response re-derived photos-then-videos.
 *
 * `sortOrder` is renumbered 0..n purely so the shape is complete; nothing
 * client-side sorts on it (see buildMediaTiles' doc) and the server's own
 * numbering replaces it on the next payload.
 *
 * `previous` entries that have no tile — a 'processing' or 'failed' video,
 * which has a real position server-side but is not in the grid — are
 * preserved at the end rather than silently dropped from the consumer's
 * state for the duration of the request.
 */
export function tilesToMedia(tiles: MediaTile[], previous?: MediaItem[]): MediaItem[] {
  const tileKeys = new Set(tiles.map(mediaTileKey));
  const items: MediaItem[] = tiles.map((tile, index) =>
    tile.kind === 'photo'
      ? { type: 'image', id: tile.mediaId, url: tile.url, sortOrder: index }
      : { ...tile.video, type: 'video', sortOrder: index },
  );
  let nextSortOrder = items.length;
  for (const item of previous ?? []) {
    if (tileKeys.has(mediaItemKey(item))) continue;
    items.push({ ...item, sortOrder: nextSortOrder });
    nextSortOrder += 1;
  }
  return items;
}

/**
 * Drops one just-deleted row from a `media` list.
 *
 * Needed because a DELETE conventionally answers 204 with no body, so
 * unlike an upload, a crop or a reorder there is no fresh `media` to
 * apply — and leaving the stale entry in place is not harmless.
 * `buildMediaTiles` would skip it (no tile), so the GRID looks right, but
 * `tilesToMedia` deliberately preserves `previous` entries it finds no
 * tile for (a 'processing' video is the case it exists for) — so the very
 * next reorder would resurrect the deleted row into the consumer's state
 * as a phantom entry. Removing it here is what keeps that invariant true.
 */
export function mediaWithout(media: MediaItem[], type: 'image' | 'video', id: string): MediaItem[] {
  return media.filter((item) => !(item.type === type && item.id === id));
}

/**
 * Re-states a `media` list against a freshly-read `videos` list, keeping
 * every POSITION `media` already has.
 *
 * The three video paths that have no `media` in their response — the
 * upload (one row), a delete (no body) and the status poll (an array of
 * rows) — all reduce to "here are this entity's videos now". Each calls
 * this with that list, so there is one rule in one place rather than three
 * hand-rolled splices.
 *
 * What it does NOT do is invent an order: a video `media` already knows
 * keeps its slot, one it no longer knows is dropped, and a video `media`
 * has never seen goes to the TAIL — the same place `buildMediaTiles`
 * already puts an item the server order does not mention, and the right
 * answer for a fresh upload because a server implementing §8 appends it.
 * If it is ever wrong — a video added in another tab AND reordered there —
 * the next full-entity payload (any reorder, crop, photo upload, or
 * reopening the form) replaces this list wholesale with the server's own.
 */
export function syncVideosIntoMedia(media: MediaItem[], videos: VideoItem[]): MediaItem[] {
  const freshById = new Map(videos.map((video) => [video.id, video]));
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  let maxSortOrder = -1;

  for (const item of media) {
    maxSortOrder = Math.max(maxSortOrder, item.sortOrder);
    if (item.type !== 'video') {
      items.push(item);
      continue;
    }
    const fresh = freshById.get(item.id);
    // Gone from `videos` means deleted — see mediaWithout's doc for why a
    // stale entry is not harmless.
    if (!fresh) continue;
    seen.add(item.id);
    // Content from the fresh row (a poll's whole job is to carry
    // 'processing' -> 'ready'), position from the entry already here.
    items.push({ ...fresh, type: 'video', sortOrder: item.sortOrder });
  }

  let nextSortOrder = maxSortOrder + 1;
  for (const video of videos) {
    if (seen.has(video.id)) continue;
    items.push({ ...video, type: 'video', sortOrder: nextSortOrder });
    nextSortOrder += 1;
  }
  return items;
}
