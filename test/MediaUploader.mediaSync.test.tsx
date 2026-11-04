import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediaUploader } from '../src/components/MediaUploader';
import { defaultLabels } from '../src/labels';
import type { MediaItem, PhotoApi, VideoApi, VideoItem } from '../src/types';
import {
  fakePhotoApi,
  fakeVideoApi,
  imageMedia,
  makePhotoFile,
  makeVideo,
  makeVideoFile,
  videoMedia,
} from './mediaFixtures';

const t = defaultLabels.uploader;

/**
 * `media` IS THE ORDER AUTHORITY. The origin project shipped it applied
 * in `reorderTo` ONLY, and a freshly uploaded photo then appeared in the
 * wrong place and moved by itself on reload. Six paths have to carry it;
 * each gets its own test here, and each test fails if its one `media`
 * application is removed.
 */

interface Harness {
  media: MediaItem[] | undefined;
  imageUrls: string[];
  videos: VideoItem[];
}

/**
 * A consumer that actually applies every callback into state, so an
 * assertion reads the state the real app would hold rather than a spy's
 * arguments. A spy on `onMediaChange` can pass while the component hands
 * it something it then never renders.
 */
function Consumer({
  api,
  video,
  initial,
  onState,
  entityId = 'entity-1',
}: {
  api: PhotoApi;
  video?: VideoApi;
  initial: Harness;
  onState: (state: Harness) => void;
  entityId?: string | null;
}) {
  const [state, setState] = useState(initial);
  onState(state);
  return (
    <>
      {/* An unrelated control, so "a pointer drag must not steal focus"
          has somewhere real for focus to already be. */}
      <button type="button">unrelated control</button>
      <MediaUploader
        entityId={entityId}
        imageUrls={state.imageUrls}
        onImageUrlsChange={(imageUrls) => setState((prev) => ({ ...prev, imageUrls }))}
        api={api}
        video={video}
        videos={state.videos}
        onVideosChange={(videos) => setState((prev) => ({ ...prev, videos }))}
        media={state.media}
        onMediaChange={(media) => setState((prev) => ({ ...prev, media }))}
        estimateVideoDurationSeconds={async () => 10}
      />
    </>
  );
}

function setup(initial: Harness, opts: { api?: PhotoApi; video?: VideoApi; entityId?: string | null } = {}) {
  const api = opts.api ?? fakePhotoApi();
  const video = opts.video;
  let latest: Harness = initial;
  const view = render(
    <Consumer
      api={api}
      video={video}
      initial={initial}
      entityId={opts.entityId}
      onState={(state) => {
        latest = state;
      }}
    />,
  );
  return { ...view, api, video, state: () => latest };
}

/** The grid's rendered order, read off the data attributes the tiles
 *  carry for exactly this purpose — a photo's identity is not readable
 *  off `img[src]` once an injected `loadImage` is in play. */
function renderedOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-media-kind]')).map(
    (el) => `${el.getAttribute('data-media-kind')}:${el.getAttribute('data-media-id')}`,
  );
}

function photoInput(): HTMLInputElement {
  return document.querySelector('input[accept="image/*"]') as HTMLInputElement;
}

function videoInput(): HTMLInputElement {
  return document.querySelector('input[accept^="video/"]') as HTMLInputElement;
}

describe('media is applied on path 1 of 6: a photo upload', () => {
  it('applies the response\'s `media`, so the new photo lands where the SERVER put it, not in the tail', async () => {
    const clip = makeVideo('5');
    const api = fakePhotoApi({
      uploadPhoto: vi.fn(async (_id: string, file: File) => ({
        fileName: file.name,
        status: 'success' as const,
        imageUrls: ['/images/10', '/images/99'],
        // The server put the new photo BEFORE the video.
        media: [imageMedia('10', 0), imageMedia('99', 1), videoMedia(clip, 2)],
      })),
    });
    const { state } = setup(
      { imageUrls: ['/images/10'], videos: [clip], media: [imageMedia('10', 0), videoMedia(clip, 1)] },
      { api, video: fakeVideoApi() },
    );

    await act(async () => {
      fireEvent.change(photoInput(), { target: { files: [makePhotoFile()] } });
    });

    await waitFor(() => expect(state().imageUrls).toEqual(['/images/10', '/images/99']));
    // Without applying `media`, /images/99 is unknown to the order list
    // and buildMediaTiles appends it to the tail — AFTER the video.
    expect(renderedOrder()).toEqual(['photo:10', 'photo:99', 'video:5']);
  });
});

describe('media is applied on path 2 of 6: a crop / replace-in-place', () => {
  it('applies the response\'s `media`, so the stale pre-crop ?v= token cannot survive into a later reorder', async () => {
    const api = fakePhotoApi({
      replaceImage: vi.fn(async () => ({
        imageUrls: ['/images/10?v=2'],
        media: [imageMedia('10', 0, '/images/10?v=2')],
      })),
    });
    const { state } = setup(
      { imageUrls: ['/images/10?v=1'], videos: [], media: [imageMedia('10', 0, '/images/10?v=1')] },
      { api },
    );

    // Drive the real crop flow: open the editor, stub the canvas pipeline
    // (JSDOM has no 2D context), rotate so there IS a change to save,
    // then Save.
    fireEvent.click(screen.getByRole('button', { name: t.editExisting(1, 1) }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb) {
      cb(new Blob(['bytes'], { type: 'image/webp' }));
    });
    const img = within(screen.getByRole('dialog')).getByAltText('') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(img);
    fireEvent.click(screen.getByRole('button', { name: defaultLabels.cropEditor.rotateRightAria }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: defaultLabels.cropEditor.save }));
    });

    await waitFor(() => expect(api.replaceImage).toHaveBeenCalledWith('entity-1', '10', expect.any(Blob)));
    // The fresh ?v= token reached BOTH lists. Leaving `media` on the
    // pre-crop url means a later optimistic reorder carries the stale
    // token, because tilesToMedia keeps `previous` entries it finds no
    // tile for.
    await waitFor(() => expect(state().media).toEqual([imageMedia('10', 0, '/images/10?v=2')]));
    expect(state().imageUrls).toEqual(['/images/10?v=2']);
    vi.restoreAllMocks();
  });
});

describe('media is applied on path 3 of 6: a photo delete', () => {
  it('drops the deleted entry, so a later reorder cannot resurrect it as a phantom', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const clip = makeVideo('6', 'processing');
    const { state } = setup(
      {
        imageUrls: ['/images/10', '/images/20'],
        videos: [clip],
        media: [imageMedia('10', 0), imageMedia('20', 1), videoMedia(clip, 2)],
      },
      { video: fakeVideoApi() },
    );

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: t.removeExisting })[0]!);
    });

    await waitFor(() => expect(state().imageUrls).toEqual(['/images/20']));
    // The 'processing' video has no tile, so `tilesToMedia` preserves it
    // — which is exactly why the DELETED photo must be removed here, or
    // the next reorder would carry it back.
    expect(state().media).toEqual([imageMedia('20', 1), videoMedia(clip, 2)]);
    vi.restoreAllMocks();
  });
});

describe('media is applied on path 4 of 6: a video upload', () => {
  it('extends `media` with the new processing row rather than leaving the two lists disagreeing', async () => {
    const newRow = makeVideo('900', 'processing');
    const video = fakeVideoApi({
      uploadVideo: vi.fn(async (_id: string, file: File) => ({
        fileName: file.name,
        status: 'success' as const,
        video: newRow,
      })),
    });
    const { state } = setup({ imageUrls: ['/images/10'], videos: [], media: [imageMedia('10', 0)] }, { video });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    await waitFor(() => expect(state().videos).toEqual([newRow]));
    // Appended to the tail, which is where a server that appends puts it.
    expect(state().media).toEqual([imageMedia('10', 0), videoMedia(newRow, 1)]);
  });
});

describe('media is applied on path 5 of 6: a video delete', () => {
  it('drops the deleted video entry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const clip = makeVideo('5');
    const { state } = setup(
      { imageUrls: ['/images/10'], videos: [clip], media: [imageMedia('10', 0), videoMedia(clip, 1)] },
      { video: fakeVideoApi() },
    );

    const tile = document.querySelector('[data-media-id="5"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: t.removeExistingVideo }));
    });

    await waitFor(() => expect(state().videos).toEqual([]));
    expect(state().media).toEqual([imageMedia('10', 0)]);
    vi.restoreAllMocks();
  });
});

describe('media is applied on path 6 of 6: the status poll', () => {
  it('keeps the newly-ready video at its STORED position instead of appending it to the tail', async () => {
    vi.useFakeTimers();
    const processing = makeVideo('5', 'processing');
    const ready = makeVideo('5', 'ready');
    const video = fakeVideoApi({ pollVideos: vi.fn(async () => [ready]) });
    const { state } = setup(
      {
        imageUrls: ['/images/10', '/images/20'],
        videos: [processing],
        // The server has it BETWEEN the two photos.
        media: [imageMedia('10', 0), videoMedia(processing, 1), imageMedia('20', 2)],
      },
      { video },
    );

    // Not a tile while processing.
    expect(renderedOrder()).toEqual(['photo:10', 'photo:20']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(state().videos).toEqual([ready]);
    // The whole point: it appears between the photos, not at the end.
    expect(renderedOrder()).toEqual(['photo:10', 'video:5', 'photo:20']);
    vi.useRealTimers();
  });

  /**
   * THE CONSEQUENTIAL HALF, and the one a mutation exposed: the
   * processing->ready test above still passes if the poll stops folding
   * rows into `media`, because a `media` entry is matched on kind+id and
   * its stale CONTENT is ignored (content comes from `videos`).
   *
   * What actually needs the fold is a row that has gone AWAY — deleted in
   * another tab, say. Without it, `media` keeps an entry the content lists
   * no longer have; the grid looks right, because `buildMediaTiles` skips
   * a row with no tile, but `tilesToMedia` deliberately PRESERVES entries
   * it finds no tile for (that is how a 'processing' video keeps its
   * slot), so the next reorder resurrects the dead row as a phantom.
   */
  it('drops a video the poll no longer reports, so a later reorder cannot resurrect it', async () => {
    vi.useFakeTimers();
    const processing = makeVideo('5', 'processing');
    const video = fakeVideoApi({ pollVideos: vi.fn(async () => []) });
    const { state } = setup(
      {
        imageUrls: ['/images/10'],
        videos: [processing],
        media: [imageMedia('10', 0), videoMedia(processing, 1)],
      },
      { video },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(state().videos).toEqual([]);
    expect(state().media).toEqual([imageMedia('10', 0)]);
    vi.useRealTimers();
  });
});

describe('the combined reorder', () => {
  it('moves a VIDEO between two photos and makes it stick', async () => {
    const clip = makeVideo('5');
    const video = fakeVideoApi({
      reorderMedia: vi.fn(async () => ({
        imageUrls: ['/images/10', '/images/20'],
        videos: [clip],
        media: [imageMedia('10', 0), videoMedia(clip, 1), imageMedia('20', 2)],
      })),
    });
    const { state } = setup(
      {
        imageUrls: ['/images/10', '/images/20'],
        videos: [clip],
        media: [imageMedia('10', 0), imageMedia('20', 1), videoMedia(clip, 2)],
      },
      { video },
    );

    expect(renderedOrder()).toEqual(['photo:10', 'photo:20', 'video:5']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveLeftVideo(3, 3) }));
    });

    expect(video.reorderMedia).toHaveBeenCalledWith('entity-1', [
      { type: 'image', id: '10' },
      { type: 'video', id: '5' },
      { type: 'image', id: '20' },
    ]);
    // It stayed moved. Before `media` existed, the response re-derived
    // photos-then-videos and snapped the tile straight back.
    await waitFor(() => expect(renderedOrder()).toEqual(['photo:10', 'video:5', 'photo:20']));
    expect(state().media).toEqual([imageMedia('10', 0), videoMedia(clip, 1), imageMedia('20', 2)]);
  });

  /**
   * THE TRAP THE ORIGIN PAID FOR. Its server validated the payload's
   * completeness against ALL videos, so while any clip was transcoding —
   * minutes — EVERY reorder of EVERY tile was rejected. The grid
   * deliberately never shows those rows, so it cannot submit them; this
   * asserts the payload really is photos + READY videos only.
   */
  it('submits NO non-ready video id, even while one is transcoding', async () => {
    const ready = makeVideo('5');
    const processing = makeVideo('6', 'processing');
    const failed = makeVideo('7', 'failed');
    const video = fakeVideoApi({
      reorderMedia: vi.fn(async () => ({ imageUrls: ['/images/10'], videos: [ready, processing, failed] })),
    });
    setup(
      {
        imageUrls: ['/images/10'],
        videos: [ready, processing, failed],
        media: [
          imageMedia('10', 0),
          videoMedia(ready, 1),
          videoMedia(processing, 2),
          videoMedia(failed, 3),
        ],
      },
      { video },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveRight(1, 2) }));
    });

    expect(video.reorderMedia).toHaveBeenCalledWith('entity-1', [
      { type: 'video', id: '5' },
      { type: 'image', id: '10' },
    ]);
  });

  it('reverts the order and alerts when the server rejects the reorder', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const clip = makeVideo('5');
    const video = fakeVideoApi({
      reorderMedia: vi.fn(async () => {
        throw new Error('order mismatch');
      }),
    });
    setup(
      {
        imageUrls: ['/images/10', '/images/20'],
        videos: [clip],
        media: [imageMedia('10', 0), imageMedia('20', 1), videoMedia(clip, 2)],
      },
      { video },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveLeftVideo(3, 3) }));
    });

    expect(alert).toHaveBeenCalledWith('order mismatch');
    await waitFor(() => expect(renderedOrder()).toEqual(['photo:10', 'photo:20', 'video:5']));
    alert.mockRestore();
  });

  it('falls back to the photo-only reorderImages when no VideoApi is supplied', async () => {
    const api = fakePhotoApi();
    setup({ imageUrls: ['/images/10', '/images/20'], videos: [], media: undefined }, { api });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveRight(1, 2) }));
    });

    expect(api.reorderImages).toHaveBeenCalledWith('entity-1', ['20', '10']);
  });

  it('announces a move with the media noun once the grid can hold more than photos', async () => {
    const clip = makeVideo('5');
    const video = fakeVideoApi({
      reorderMedia: vi.fn(async () => ({ imageUrls: ['/images/10'], videos: [clip] })),
    });
    setup(
      { imageUrls: ['/images/10'], videos: [clip], media: [imageMedia('10', 0), videoMedia(clip, 1)] },
      { video },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveRight(1, 2) }));
    });

    expect(screen.getByText(t.mediaMoveAnnouncement(1, 2, 2))).toBeInTheDocument();
  });

  it('announces a move with the photo noun in a photo-only grid', async () => {
    setup({ imageUrls: ['/images/10', '/images/20'], videos: [], media: undefined });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveRight(1, 2) }));
    });

    expect(screen.getByText(t.moveAnnouncement(1, 2, 2))).toBeInTheDocument();
  });
});

describe('reorder focus: keyboard may refocus, a pointer drag must not', () => {
  /**
   * Both halves of a bug an adversarial review caught in the origin
   * project. JSDOM has no focus-management engine, so it cannot reproduce
   * the real-browser blur this machinery compensates for (that is
   * e2e/media-uploader-focus.spec.ts's job) — but it CAN observe whether
   * `.focus()` is called, which is the half that went wrong.
   */
  it('refocuses the moved tile after a KEYBOARD move', async () => {
    setup({ imageUrls: ['/images/10', '/images/20', '/images/30'], videos: [], media: undefined });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.moveRight(1, 3) }));
    });

    expect(document.activeElement?.getAttribute('aria-label')).toBe(t.moveRight(2, 3));
  });

  it('does NOT move focus after a POINTER drag & drop', async () => {
    setup({ imageUrls: ['/images/10', '/images/20', '/images/30'], videos: [], media: undefined });

    // Something unrelated holds focus before the drag.
    const elsewhere = screen.getByRole('button', { name: 'unrelated control' });
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    const tiles = Array.from(document.querySelectorAll('[data-media-kind]')) as HTMLElement[];
    await act(async () => {
      fireEvent.dragStart(tiles[0]!);
      fireEvent.dragOver(tiles[2]!);
      fireEvent.drop(tiles[2]!);
    });

    // Focus stayed exactly where the user put it. The shipped bug moved
    // it onto a 28px arrow button, so the next Space/Enter hit that.
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('a consumer that supplies no `media`', () => {
  it('never has one invented for it — it stays on the documented photos-then-videos fallback', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const clip = makeVideo('5');
    const onMediaChange = vi.fn();
    render(
      <MediaUploader
        entityId="entity-1"
        imageUrls={['/images/10']}
        onImageUrlsChange={vi.fn()}
        api={fakePhotoApi()}
        video={fakeVideoApi()}
        videos={[clip]}
        onVideosChange={vi.fn()}
        onMediaChange={onMediaChange}
        estimateVideoDurationSeconds={async () => 10}
      />,
    );

    // A delete is one of the paths that DERIVES a new media list rather
    // than receiving one.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.removeExisting }));
    });

    // Nothing was invented: no media list reached the consumer, and the
    // grid is still the photos-then-videos derivation.
    expect(onMediaChange).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
