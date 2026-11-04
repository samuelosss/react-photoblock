import { useMemo, useState } from 'react';
import { MediaUploader } from '../../../src/components/MediaUploader';
import type { MediaItem, PhotoApi, VideoApi, VideoItem } from '../../../src/types';

/**
 * Playwright-only harness — mounts MediaUploader standalone with video
 * support wired to in-memory fakes, no backend involved.
 *
 * It exists for the two claims JSDOM structurally cannot make:
 *
 *  - THE PLAY AFFORDANCE'S PROPORTION. The origin project's first attempt
 *    at "a disc that scales with its tile" used a `clamp()` whose floor
 *    bound on small cells and ceiling on large ones, which INVERTED the
 *    intent — the badge covered ~60% of a small tile and ~17% of a hero.
 *    Absolute-pixel assertions are exactly how that passed review, and
 *    JSDOM has no layout engine to measure either number. Hence
 *    `?tile=<px>`: it pins the grid to ONE column of that width, so a
 *    spec can measure the same ratio in two very different tiles.
 *
 *  - THE GRID'S PAINTED ORDER. "The video sits between the two photos" is
 *    a claim about x-coordinates. Document order and painted position are
 *    not the same claim: an `order`, `column-reverse`, `direction` or grid
 *    change could separate them with the DOM untouched, and a DOM-order
 *    test would stay green through it.
 *
 * Query parameters:
 *   `tile=<px>`     pin the grid to one column of that width (default: the
 *                   package's own responsive grid).
 *   `processing=1`  include a 'processing' video, to prove it is NOT a
 *                   tile and DOES appear in the queue panel.
 */

const PHOTO_A = '/e2e-fixtures/landscape-2400x1800.svg';
const PHOTO_B = '/e2e-fixtures/portrait-1800x2400.svg';
const POSTER = '/e2e-fixtures/ratio16x9-1920x1080.svg';

/**
 * The package recovers an id from a `/images/<id>` url (see
 * `extractImageId`). These fixtures are static files served by the harness
 * dev server, so the id is appended as a URL FRAGMENT — browsers ignore it
 * when resolving the file, and it still gives the parser the shape it
 * looks for. Do not copy this trick into a real backend; it exists only
 * because this harness has no `/images/<id>` route.
 */
function photoUrl(file: string, id: string): string {
  return `${file}#/images/${id}`;
}

function readyVideo(id: string): VideoItem {
  return {
    id,
    status: 'ready',
    errorMessage: null,
    posterUrl: POSTER,
    videoUrl: '/e2e-fixtures/nonexistent.mp4',
    durationMs: 65_000,
    byteSize: 2 * 1024 * 1024,
    width: 1920,
    height: 1080,
  };
}

function processingVideo(id: string): VideoItem {
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

const NOT_EXERCISED = () => Promise.reject(new Error('not exercised by this harness'));

export function VideoUploaderHarness() {
  const params = new URLSearchParams(window.location.search);
  const tileWidth = params.get('tile');
  const withProcessing = params.get('processing') === '1';

  const photoA = photoUrl(PHOTO_A, '10');
  const photoB = photoUrl(PHOTO_B, '20');

  const [imageUrls, setImageUrls] = useState<string[]>([photoA, photoB]);
  const [videos, setVideos] = useState<VideoItem[]>(
    withProcessing ? [readyVideo('5'), processingVideo('6')] : [readyVideo('5')],
  );
  // The server's order: photos either side of the video. The arrangement
  // `imageUrls: string[]` cannot express at all.
  const [media, setMedia] = useState<MediaItem[] | undefined>(() => {
    const items: MediaItem[] = [
      { type: 'image', id: '10', url: photoA, sortOrder: 0 },
      { ...readyVideo('5'), type: 'video', sortOrder: 1 },
      { type: 'image', id: '20', url: photoB, sortOrder: 2 },
    ];
    if (withProcessing) items.push({ ...processingVideo('6'), type: 'video', sortOrder: 3 });
    return items;
  });

  const api: PhotoApi = useMemo(
    () => ({
      uploadPhoto: NOT_EXERCISED,
      deleteImage: NOT_EXERCISED,
      reorderImages: NOT_EXERCISED,
      replaceImage: NOT_EXERCISED,
    }),
    [],
  );

  const video: VideoApi = useMemo(
    () => ({
      uploadVideo: NOT_EXERCISED,
      deleteVideo: () => Promise.resolve(),
      pollVideos: () => Promise.resolve(withProcessing ? [readyVideo('5'), processingVideo('6')] : [readyVideo('5')]),
      // A real backend re-merges and returns its own authoritative order.
      // This fake echoes the requested order back, which is enough for a
      // spec about what the grid PAINTS.
      reorderMedia: (_entityId, items) =>
        Promise.resolve({
          imageUrls: items
            .filter((item) => item.type === 'image')
            .map((item) => (item.id === '10' ? photoA : photoB)),
          videos,
          media: items.map((item, index) =>
            item.type === 'image'
              ? { type: 'image' as const, id: item.id, url: item.id === '10' ? photoA : photoB, sortOrder: index }
              : { ...readyVideo(item.id), type: 'video' as const, sortOrder: index },
          ),
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [withProcessing, videos],
  );

  return (
    <div>
      {/* Pins the grid to one column of a known width. The package's grid
          template is ordinary CSS a consumer can override, and the
          proportion claim has to hold across whatever sizes that
          produces — so forcing a size here is testing the rule, not
          bypassing it. */}
      {tileWidth && (
        <style>{`[class*="grid"] { grid-template-columns: ${Number(tileWidth)}px !important; }`}</style>
      )}
      <MediaUploader
        entityId="1"
        imageUrls={imageUrls}
        onImageUrlsChange={setImageUrls}
        api={api}
        video={video}
        videos={videos}
        onVideosChange={setVideos}
        media={media}
        onMediaChange={setMedia}
      />
    </div>
  );
}
