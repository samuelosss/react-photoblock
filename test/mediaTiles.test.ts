import { describe, expect, it } from 'vitest';
import {
  buildMediaTiles,
  extractImageId,
  mediaItemKey,
  mediaTileKey,
  mediaWithout,
  syncVideosIntoMedia,
  tilesToMedia,
  tilesToMediaOrder,
} from '../src/components/mediaTiles';
import type { MediaTile } from '../src/components/mediaTiles';
import type { MediaItem, VideoItem, VideoStatus } from '../src/types';

function video(id: string, status: VideoStatus = 'ready', overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id,
    status,
    errorMessage: status === 'failed' ? 'transcode failed' : null,
    posterUrl: status === 'ready' ? `/api/videos/${id}/poster` : null,
    videoUrl: status === 'ready' ? `/api/videos/${id}/file.mp4` : null,
    durationMs: status === 'ready' ? 12_000 : null,
    byteSize: status === 'ready' ? 1_000_000 : null,
    width: status === 'ready' ? 1280 : null,
    height: status === 'ready' ? 720 : null,
    ...overrides,
  };
}

function imageItem(id: string, sortOrder: number, url = `/images/${id}`): MediaItem {
  return { type: 'image', id, url, sortOrder };
}

function videoItem(row: VideoItem, sortOrder: number): MediaItem {
  return { ...row, type: 'video', sortOrder };
}

/** The grid's rendered order, as a compact, readable string. */
function order(tiles: MediaTile[]): string[] {
  return tiles.map((tile) => `${tile.kind}:${tile.mediaId}`);
}

describe('extractImageId', () => {
  it('recovers the id from a bare url and from one carrying a ?v= version token', () => {
    expect(extractImageId('/images/42')).toBe('42');
    expect(extractImageId('/images/42?v=1700000000000')).toBe('42');
    expect(extractImageId('https://cdn.example.test/images/abc-def?v=9')).toBe('abc-def');
  });

  it('returns null for a url that is not shaped like /images/<id>', () => {
    expect(extractImageId('/thumbnails/42')).toBeNull();
    expect(extractImageId('blob:http://localhost/xyz')).toBeNull();
  });
});

describe('mediaTileKey / mediaItemKey', () => {
  /**
   * The whole reason both exist. A photo and a video can carry the same
   * id, so a lookup keyed on the bare id would match one against the
   * other and reorder the wrong row.
   */
  it('namespaces by kind, so a photo and a video with the SAME id never collide', () => {
    const photo: MediaTile = { kind: 'photo', url: '/images/10', mediaId: '10' };
    const clip: MediaTile = { kind: 'video', video: video('10'), mediaId: '10' };

    expect(mediaTileKey(photo)).not.toBe(mediaTileKey(clip));
    expect(mediaItemKey(imageItem('10', 0))).toBe(mediaTileKey(photo));
    expect(mediaItemKey(videoItem(video('10'), 1))).toBe(mediaTileKey(clip));
  });
});

describe('buildMediaTiles', () => {
  it('falls back to photos-then-videos when no server `media` is supplied', () => {
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10', '/images/20'],
      videos: [video('5')],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:10', 'photo:20', 'video:5']);
  });

  it('honours `media`\'s ARRAY ORDER, so a video can sit BETWEEN two photos', () => {
    const clip = video('5');
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10', '/images/20'],
      videos: [clip],
      media: [imageItem('10', 0), videoItem(clip, 1), imageItem('20', 2)],
      videoMode: true,
    });
    // The arrangement `imageUrls: string[]` cannot express at all.
    expect(order(tiles)).toEqual(['photo:10', 'video:5', 'photo:20']);
  });

  it('ignores `sortOrder` and sorts on nothing — the array order IS the contract', () => {
    const clip = video('5');
    // sortOrder values deliberately disagree with the array order. The
    // server owns the merge rule; re-sorting here is how two clients
    // drift apart.
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10', '/images/20'],
      videos: [clip],
      media: [imageItem('20', 999), videoItem(clip, 0), imageItem('10', 500)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:20', 'video:5', 'photo:10']);
  });

  it('NEVER makes a tile of a processing or failed video — they have no poster', () => {
    const processing = video('5', 'processing');
    const failed = video('6', 'failed');
    const ready = video('7');
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10'],
      videos: [processing, failed, ready],
      media: [videoItem(processing, 0), imageItem('10', 1), videoItem(failed, 2), videoItem(ready, 3)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:10', 'video:7']);
  });

  it('makes no video tiles at all when videoMode is off', () => {
    const clip = video('5');
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10'],
      videos: [clip],
      media: [videoItem(clip, 0), imageItem('10', 1)],
      videoMode: false,
    });
    expect(order(tiles)).toEqual(['photo:10']);
  });

  it('appends anything `media` does not mention to the TAIL — the fresh-upload case', () => {
    const clip = video('5');
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10', '/images/99'],
      videos: [clip],
      // `media` predates the /images/99 upload.
      media: [imageItem('10', 0), videoItem(clip, 1)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:10', 'video:5', 'photo:99']);
  });

  it('drops a `media` entry whose row is gone from the content lists (the delete case)', () => {
    const tiles = buildMediaTiles({
      imageUrls: ['/images/20'],
      videos: [],
      media: [imageItem('10', 0), imageItem('20', 1)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:20']);
  });

  it('takes the photo URL from `imageUrls`, not `media` — so a crop\'s fresh ?v= shows immediately', () => {
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10?v=222'],
      videos: [],
      media: [imageItem('10', 0, '/images/10?v=111')],
      videoMode: true,
    });
    expect(tiles[0]).toEqual({ kind: 'photo', url: '/images/10?v=222', mediaId: '10' });
  });

  it('takes the video row from `videos`, not `media` — so a poll\'s processing->ready shows immediately', () => {
    const stale = video('5', 'processing');
    const tiles = buildMediaTiles({
      imageUrls: [],
      videos: [video('5', 'ready')],
      media: [videoItem(stale, 0)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['video:5']);
  });

  it('renders a duplicated `media` entry only once', () => {
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10'],
      videos: [],
      media: [imageItem('10', 0), imageItem('10', 1)],
      videoMode: true,
    });
    expect(order(tiles)).toEqual(['photo:10']);
  });
});

describe('tilesToMediaOrder', () => {
  /**
   * Half of the §8 contract, and the half this package can actually
   * enforce: the payload cannot contain a non-ready video, because a
   * non-ready video is not a tile.
   */
  it('submits photos and READY videos only, in grid order', () => {
    const tiles = buildMediaTiles({
      imageUrls: ['/images/10'],
      videos: [video('5'), video('6', 'processing')],
      videoMode: true,
    });
    expect(tilesToMediaOrder(tiles)).toEqual([
      { type: 'image', id: '10' },
      { type: 'video', id: '5' },
    ]);
  });
});

describe('tilesToMedia', () => {
  it('renumbers sortOrder 0..n so the optimistic shape is complete', () => {
    const clip = video('5');
    const tiles: MediaTile[] = [
      { kind: 'video', video: clip, mediaId: '5' },
      { kind: 'photo', url: '/images/10', mediaId: '10' },
    ];
    expect(tilesToMedia(tiles)).toEqual([
      { ...clip, type: 'video', sortOrder: 0 },
      { type: 'image', id: '10', url: '/images/10', sortOrder: 1 },
    ]);
  });

  /**
   * A 'processing' video has a real position server-side but no tile.
   * Dropping it from the optimistic payload would remove it from the
   * consumer's state for the duration of the request.
   */
  it('preserves a `previous` entry that has no tile, at the end', () => {
    const processing = video('6', 'processing');
    const tiles: MediaTile[] = [{ kind: 'photo', url: '/images/10', mediaId: '10' }];
    expect(tilesToMedia(tiles, [imageItem('10', 0), videoItem(processing, 1)])).toEqual([
      { type: 'image', id: '10', url: '/images/10', sortOrder: 0 },
      { ...processing, type: 'video', sortOrder: 1 },
    ]);
  });
});

describe('mediaWithout', () => {
  it('drops only the named row, matching on type AND id', () => {
    const clip = video('10');
    const media = [imageItem('10', 0), videoItem(clip, 1)];
    // Same id, different type — removing the image must leave the video.
    expect(mediaWithout(media, 'image', '10')).toEqual([{ ...clip, type: 'video', sortOrder: 1 }]);
    expect(mediaWithout(media, 'video', '10')).toEqual([imageItem('10', 0)]);
  });
});

describe('syncVideosIntoMedia', () => {
  it('keeps a known video\'s POSITION while taking its content fresh (processing -> ready)', () => {
    const before = video('5', 'processing');
    const after = video('5', 'ready');
    const result = syncVideosIntoMedia([videoItem(before, 0), imageItem('10', 1)], [after]);
    expect(result).toEqual([
      { ...after, type: 'video', sortOrder: 0 },
      imageItem('10', 1),
    ]);
  });

  it('drops a video that is no longer in the fresh list (deleted elsewhere)', () => {
    const gone = video('5');
    expect(syncVideosIntoMedia([imageItem('10', 0), videoItem(gone, 1)], [])).toEqual([imageItem('10', 0)]);
  });

  it('appends a video `media` has never seen to the TAIL, past the current max sortOrder', () => {
    const fresh = video('9', 'processing');
    const result = syncVideosIntoMedia([imageItem('10', 40)], [fresh]);
    expect(result).toEqual([imageItem('10', 40), { ...fresh, type: 'video', sortOrder: 41 }]);
  });

  it('leaves photo entries untouched', () => {
    const media = [imageItem('10', 0), imageItem('20', 1)];
    expect(syncVideosIntoMedia(media, [])).toEqual(media);
  });
});
