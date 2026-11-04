import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaUploader } from '../src/components/MediaUploader';
import { defaultLabels } from '../src/labels';
import type { VideoApi } from '../src/types';
import { fakePhotoApi, fakeVideoApi, makeVideo, makeVideoFile } from './mediaFixtures';

const t = defaultLabels.uploader;

/** The duration probe is injected because JSDOM never fires
 *  `loadedmetadata` — without this, the whole estimate gate would be
 *  untestable rather than merely unobserved. */
function probe(seconds: number | null) {
  return vi.fn(async () => seconds);
}

function renderUploader(props: {
  video?: VideoApi;
  videos?: ReturnType<typeof makeVideo>[];
  entityId?: string | null;
  durationSeconds?: number | null;
  videoLimits?: Parameters<typeof MediaUploader>[0]['videoLimits'];
  onVideosChange?: (videos: ReturnType<typeof makeVideo>[]) => void;
}) {
  const video = props.video ?? fakeVideoApi();
  const api = fakePhotoApi();
  const onVideosChange = props.onVideosChange ?? vi.fn();
  const view = render(
    <MediaUploader
      entityId={props.entityId === undefined ? 'entity-1' : props.entityId}
      imageUrls={[]}
      onImageUrlsChange={vi.fn()}
      api={api}
      video={video}
      videos={props.videos ?? []}
      onVideosChange={onVideosChange}
      videoLimits={props.videoLimits}
      estimateVideoDurationSeconds={probe(props.durationSeconds ?? 10)}
    />,
  );
  return { ...view, video, api, onVideosChange };
}

function videoInput(): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
  const found = inputs.find((input) => input.getAttribute('accept')?.startsWith('video/'));
  if (!found) throw new Error('no video file input rendered');
  return found;
}

describe('MediaUploader — video support is gated on the VideoApi prop', () => {
  it('renders no video dropzone, no accept="video/*" input and no video hint without it', () => {
    render(<MediaUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={vi.fn()} api={fakePhotoApi()} />);

    expect(screen.queryByText(t.videoDropzoneIdle)).not.toBeInTheDocument();
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.getAttribute('accept')).toBe('image/*');
  });

  it('renders the video dropzone, with the accepted containers on the input, once it IS supplied', () => {
    renderUploader({});
    expect(screen.getByText(t.videoDropzoneIdle)).toBeInTheDocument();
    expect(videoInput().getAttribute('accept')).toBe('video/mp4,video/quicktime,video/x-matroska,video/webm');
  });

  /**
   * A READY video has a poster, so it is a grid tile. A non-ready one has
   * none (`posterUrl` is null until the transcode succeeds), so it must
   * NOT be — a blank square in the mosaic is not an improvement.
   */
  it('renders a READY video as a grid tile, with its poster and duration', () => {
    renderUploader({ videos: [makeVideo('5')] });

    const tile = document.querySelector('[data-media-kind="video"][data-media-id="5"]');
    expect(tile).not.toBeNull();
    expect(tile!.querySelector('img')!.getAttribute('src')).toBe('/api/admin/videos/5/poster?v=1');
    expect(within(tile as HTMLElement).getByText('1:05')).toBeInTheDocument();
  });

  it.each(['processing', 'failed'] as const)(
    'never renders a %s video as a grid tile, only in the queue panel',
    (status) => {
      renderUploader({ videos: [makeVideo('5', status)] });

      expect(document.querySelector('[data-media-kind="video"]')).toBeNull();
      const queue = screen.getByLabelText(t.videoQueueRegionLabel);
      expect(within(queue).getByText(t.videoQueueRowName)).toBeInTheDocument();
    },
  );

  it('offers retry and delete on a failed row, with the server\'s own error message', () => {
    renderUploader({ videos: [makeVideo('5', 'failed')] });
    const queue = screen.getByLabelText(t.videoQueueRegionLabel);

    expect(within(queue).getByText('ffmpeg: not a video')).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: t.retryButtonText })).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: t.videoDeleteButtonText })).toBeInTheDocument();
  });
});

describe('MediaUploader — the size-warning gate before a video upload', () => {
  it('uploads straight away when the estimate is under the warn threshold', async () => {
    const { video } = renderUploader({ durationSeconds: 10 });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(t.videoStatusAwaitingConfirmation)).not.toBeInTheDocument();
  });

  it('asks for confirmation BEFORE uploading when the estimate is over the threshold, and uploads nothing until then', async () => {
    // 600s * ~104.9KB/s ≈ 60 MB, over the 25 MB default.
    const { video } = renderUploader({ durationSeconds: 600 });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    expect(screen.getByText(t.videoStatusAwaitingConfirmation)).toBeInTheDocument();
    expect(screen.getByText(/~60 MB/)).toBeInTheDocument();
    expect(video.uploadVideo).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.videoUploadAnywayText }));
    });
    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(1));
  });

  it('is SOFT: cancelling the warning drops the item and uploads nothing', async () => {
    const { video } = renderUploader({ durationSeconds: 600 });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });
    const queue = screen.getByLabelText(t.videoQueueRegionLabel);
    await act(async () => {
      fireEvent.click(within(queue).getByRole('button', { name: t.cancelButtonText }));
    });

    expect(video.uploadVideo).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(t.videoQueueRegionLabel)).not.toBeInTheDocument();
  });

  it('skips the warning entirely when the duration cannot be read (no estimate, no guess)', async () => {
    const { video } = renderUploader({ durationSeconds: null });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(1));
  });

  it('uses the consumer\'s own threshold, not the default', async () => {
    // 10s ≈ 1 MB, which is over a 100-byte threshold.
    const { video } = renderUploader({ durationSeconds: 10, videoLimits: { sizeWarnBytes: 100 } });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    expect(screen.getByText(t.videoStatusAwaitingConfirmation)).toBeInTheDocument();
    expect(video.uploadVideo).not.toHaveBeenCalled();
  });
});

describe('MediaUploader — client-side video rejections never start an upload', () => {
  it('rejects a file over maxBytes without calling uploadVideo', async () => {
    const { video } = renderUploader({ videoLimits: { maxBytes: 1024 } });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile('big.mp4', 4096)] } });
    });

    expect(screen.getByText(t.videoTooLarge(4096, 1024))).toBeInTheDocument();
    expect(video.uploadVideo).not.toHaveBeenCalled();
  });

  it('rejects a clip over maxDurationSeconds without calling uploadVideo', async () => {
    const { video } = renderUploader({ durationSeconds: 1200, videoLimits: { maxDurationSeconds: 900 } });

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });

    expect(screen.getByText(t.videoTooLong(1200, 900))).toBeInTheDocument();
    expect(video.uploadVideo).not.toHaveBeenCalled();
  });

  it('ignores a file whose type is not an accepted container', async () => {
    const { video } = renderUploader({});

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile('doc.pdf', 1000, 'application/pdf')] } });
    });

    expect(video.uploadVideo).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(t.videoQueueRegionLabel)).not.toBeInTheDocument();
  });
});

describe('MediaUploader — a video picked before the first save', () => {
  it('queues locally with no upload, then uploads automatically once entityId becomes real', async () => {
    const video = fakeVideoApi();
    const api = fakePhotoApi();
    const { rerender } = render(
      <MediaUploader
        entityId={null}
        imageUrls={[]}
        onImageUrlsChange={vi.fn()}
        api={api}
        video={video}
        videos={[]}
        onVideosChange={vi.fn()}
        estimateVideoDurationSeconds={probe(10)}
      />,
    );

    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });
    expect(screen.getByText(t.videoStatusQueued)).toBeInTheDocument();
    expect(video.uploadVideo).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <MediaUploader
          entityId="entity-1"
          imageUrls={[]}
          onImageUrlsChange={vi.fn()}
          api={api}
          video={video}
          videos={[]}
          onVideosChange={vi.fn()}
          estimateVideoDurationSeconds={probe(10)}
        />,
      );
    });

    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledWith('entity-1', expect.any(File), expect.any(Function)));
  });
});

describe('MediaUploader — retrying a video that failed AFTER a server row existed', () => {
  it('deletes the failed row and re-uploads when THIS TAB still holds the file', async () => {
    const processing = makeVideo('900', 'processing');
    const video = fakeVideoApi({
      uploadVideo: vi.fn(async (_id: string, file: File) => ({
        fileName: file.name,
        status: 'success' as const,
        video: processing,
      })),
    });
    const api = fakePhotoApi();
    const onVideosChange = vi.fn();

    // Upload it first, so uploadedFilesRef holds the File, then rerender
    // with the row having reached 'failed'.
    const { rerender } = render(
      <MediaUploader
        entityId="entity-1"
        imageUrls={[]}
        onImageUrlsChange={vi.fn()}
        api={api}
        video={video}
        videos={[]}
        onVideosChange={onVideosChange}
        estimateVideoDurationSeconds={probe(10)}
      />,
    );
    await act(async () => {
      fireEvent.change(videoInput(), { target: { files: [makeVideoFile()] } });
    });
    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender(
        <MediaUploader
          entityId="entity-1"
          imageUrls={[]}
          onImageUrlsChange={vi.fn()}
          api={api}
          video={video}
          videos={[makeVideo('900', 'failed')]}
          onVideosChange={onVideosChange}
          estimateVideoDurationSeconds={probe(10)}
        />,
      );
    });

    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const queue = screen.getByLabelText(t.videoQueueRegionLabel);
    await act(async () => {
      fireEvent.click(within(queue).getByRole('button', { name: t.retryButtonText }));
    });

    expect(video.deleteVideo).toHaveBeenCalledWith('entity-1', '900');
    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(2));
    // The point of the whole branch: no "please re-pick the file" alert.
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  /**
   * After a page reload — or when the failure is discovered on a LATER
   * visit — this tab has no bytes to resend. Saying so is the whole
   * point; a button that silently no-ops would be worse.
   */
  it('deletes the row and says the file must be re-picked when this tab does NOT hold it', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { video } = renderUploader({ videos: [makeVideo('5', 'failed')] });

    const queue = screen.getByLabelText(t.videoQueueRegionLabel);
    await act(async () => {
      fireEvent.click(within(queue).getByRole('button', { name: t.retryButtonText }));
    });

    expect(video.deleteVideo).toHaveBeenCalledWith('entity-1', '5');
    expect(alert).toHaveBeenCalledWith(t.videoRetryUnavailable);
    expect(video.uploadVideo).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});

describe('MediaUploader — deleting a video', () => {
  it('confirms first, and does nothing if the confirm is dismissed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { video } = renderUploader({ videos: [makeVideo('5')] });

    const tile = document.querySelector('[data-media-id="5"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: t.removeExistingVideo }));
    });

    expect(confirm).toHaveBeenCalledWith(t.confirmDeleteVideo);
    expect(video.deleteVideo).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('deletes and drops the row from the videos list once confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onVideosChange = vi.fn();
    const { video } = renderUploader({ videos: [makeVideo('5'), makeVideo('6')], onVideosChange });

    const tile = document.querySelector('[data-media-id="5"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: t.removeExistingVideo }));
    });

    expect(video.deleteVideo).toHaveBeenCalledWith('entity-1', '5');
    expect(onVideosChange).toHaveBeenCalledWith([makeVideo('6')]);
    confirm.mockRestore();
  });
});

describe('MediaUploader — the after-transcode size warning on a ready tile', () => {
  it('shows it only for a video over the warn threshold, and lets it be dismissed', async () => {
    const big = makeVideo('5', 'ready', { byteSize: 40 * 1024 * 1024 });
    const small = makeVideo('6', 'ready', { byteSize: 1024 });
    renderUploader({ videos: [big, small] });

    expect(screen.getByText(t.videoSizeWarning(40 * 1024 * 1024))).toBeInTheDocument();
    expect(screen.queryByText(t.videoSizeWarning(1024))).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.videoSizeWarningDismiss }));
    });
    expect(screen.queryByText(t.videoSizeWarning(40 * 1024 * 1024))).not.toBeInTheDocument();
  });
});

describe('MediaUploader — the status poll', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls while a row is processing and stops once nothing is', async () => {
    vi.useFakeTimers();
    const video = fakeVideoApi({ pollVideos: vi.fn(async () => [makeVideo('5', 'ready')]) });
    const onVideosChange = vi.fn();
    const api = fakePhotoApi();

    const { rerender } = render(
      <MediaUploader
        entityId="entity-1"
        imageUrls={[]}
        onImageUrlsChange={vi.fn()}
        api={api}
        video={video}
        videos={[makeVideo('5', 'processing')]}
        onVideosChange={onVideosChange}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(video.pollVideos).toHaveBeenCalledWith('entity-1');
    expect(onVideosChange).toHaveBeenCalledWith([makeVideo('5', 'ready')]);

    // Re-render with the row now ready, as a real consumer would after
    // applying that callback — the poll must stop.
    await act(async () => {
      rerender(
        <MediaUploader
          entityId="entity-1"
          imageUrls={[]}
          onImageUrlsChange={vi.fn()}
          api={api}
          video={video}
          videos={[makeVideo('5', 'ready')]}
          onVideosChange={onVideosChange}
        />,
      );
    });
    const callsAfterReady = (video.pollVideos as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect((video.pollVideos as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterReady);
  });

  it('never polls when nothing is processing', async () => {
    vi.useFakeTimers();
    const { video } = renderUploader({ videos: [makeVideo('5', 'ready')] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(video.pollVideos).not.toHaveBeenCalled();
  });

  it('swallows a transient poll failure and keeps trying rather than alerting', async () => {
    vi.useFakeTimers();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const pollVideos = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([makeVideo('5', 'ready')]);
    const onVideosChange = vi.fn();
    render(
      <MediaUploader
        entityId="entity-1"
        imageUrls={[]}
        onImageUrlsChange={vi.fn()}
        api={fakePhotoApi()}
        video={fakeVideoApi({ pollVideos })}
        videos={[makeVideo('5', 'processing')]}
        onVideosChange={onVideosChange}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(alert).not.toHaveBeenCalled();
    expect(onVideosChange).toHaveBeenCalledWith([makeVideo('5', 'ready')]);
    alert.mockRestore();
  });
});
