import { vi } from 'vitest';
import type {
  ImageUrlsResult,
  MediaItem,
  PhotoApi,
  UploadResult,
  VideoApi,
  VideoItem,
  VideoStatus,
} from '../src/types';

/** A server video row, defaulting to the shape a READY one has. */
export function makeVideo(id: string, status: VideoStatus = 'ready', overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id,
    status,
    errorMessage: status === 'failed' ? 'ffmpeg: not a video' : null,
    posterUrl: status === 'ready' ? `/api/admin/videos/${id}/poster?v=1` : null,
    videoUrl: status === 'ready' ? `/api/admin/videos/${id}/file.mp4` : null,
    durationMs: status === 'ready' ? 65_000 : null,
    byteSize: status === 'ready' ? 2 * 1024 * 1024 : null,
    width: status === 'ready' ? 1280 : null,
    height: status === 'ready' ? 720 : null,
    ...overrides,
  };
}

export function imageMedia(id: string, sortOrder: number, url = `/images/${id}`): MediaItem {
  return { type: 'image', id, url, sortOrder };
}

export function videoMedia(row: VideoItem, sortOrder: number): MediaItem {
  return { ...row, type: 'video', sortOrder };
}

export function fakePhotoApi(overrides: Partial<PhotoApi> = {}): PhotoApi {
  return {
    uploadPhoto: vi.fn(async (_entityId: string, file: File): Promise<UploadResult> => ({
      fileName: file.name,
      status: 'success',
      imageUrls: [`/images/${file.name}`],
    })),
    deleteImage: vi.fn(async () => {}),
    reorderImages: vi.fn(async (_entityId: string, ids: string[]): Promise<ImageUrlsResult> => ({
      imageUrls: ids.map((id) => `/images/${id}`),
    })),
    replaceImage: vi.fn(async (_entityId: string, imageId: string): Promise<ImageUrlsResult> => ({
      imageUrls: [`/images/${imageId}?v=2`],
    })),
    ...overrides,
  };
}

export function fakeVideoApi(overrides: Partial<VideoApi> = {}): VideoApi {
  return {
    uploadVideo: vi.fn(async (_entityId: string, file: File) => ({
      fileName: file.name,
      status: 'success' as const,
      video: makeVideo('900', 'processing'),
    })),
    deleteVideo: vi.fn(async () => {}),
    pollVideos: vi.fn(async () => []),
    reorderMedia: vi.fn(async () => ({ imageUrls: [], videos: [] })),
    ...overrides,
  };
}

/** A video File the component's MIME filter accepts. `size` is overridden
 *  because a real Blob of 300 MB is not something to build in a test. */
export function makeVideoFile(name = 'clip.mp4', sizeBytes = 5 * 1024 * 1024, type = 'video/mp4'): File {
  const file = new File(['v'], name, { type });
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

export function makePhotoFile(name = 'sunset.png'): File {
  return new File(['x'], name, { type: 'image/png' });
}
