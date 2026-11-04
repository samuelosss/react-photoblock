/**
 * Shared types for the package's data-in/data-out contract. None of these
 * describe HTTP — they describe the shapes the injected API functions
 * (uploadPhoto, deleteImage, reorderImages, replaceImage, and optionally
 * uploadVideo, deleteVideo, pollVideos, reorderMedia) must return.
 * See docs/server-contract.md for what a backend needs to implement to
 * produce these shapes.
 */

/** Result of one file upload. */
export interface UploadResult {
  fileName: string;
  status: 'success' | 'error';
  error?: string;
  /** The owning entity's fresh image URL list, present only on success.
   *  The component always prefers this over guessing the new URL/id
   *  client-side, so it stays correct however the server orders images. */
  imageUrls?: string[];
  /**
   * The entity's fresh ORDERED media list, when your upload endpoint
   * answers with the whole entity rather than only its images.
   *
   * SUPPLY THIS IF YOU SUPPORT VIDEO. `imageUrls` carries no position, so
   * applying it alone leaves `media` on its pre-upload value and the new
   * photo lands in `buildMediaTiles`' unknown tail — i.e. behind every
   * video, wherever the server actually put it. In the origin project that
   * was a real, shipped bug: a server order of [P1, V1, P2] rendered as
   * [P1, V1, V2, P2] as soon as a second video existed, and reloading the
   * form moved the tile by itself.
   */
  media?: MediaItem[];
}

/** Minimal shape reorderImages/replaceImage need to return. Both are
 *  free to return a larger object (e.g. the whole updated entity) — the
 *  component reads `imageUrls` and, when present, `media` off the
 *  result. */
export interface ImageUrlsResult {
  imageUrls: string[];
  /** See `UploadResult.media` — same reasoning, and docs/server-contract.md
   *  §9 lists all six mutation paths that must carry it. */
  media?: MediaItem[];
}

// --- Video --------------------------------------------------------------
// Entirely optional. Everything below is inert unless a `VideoApi` is
// injected. See docs/server-contract.md §6-§9 for the server half.

/**
 * Transcode lifecycle of one uploaded video, as the SERVER reports it.
 * Never computed client-side: this package hands a file to your
 * `uploadVideo` and then polls your `pollVideos` until the status moves.
 *
 * 'processing' and 'failed' rows have NO poster (see `posterUrl`), so they
 * are deliberately not grid tiles — they render in a separate queue panel
 * instead. A blank square in the mosaic is not an improvement.
 */
export type VideoStatus = 'processing' | 'ready' | 'failed';

/**
 * One video row. This package has no codec knowledge and runs no
 * transcode — TRANSCODING IS THE SERVER'S JOB. All this type describes is
 * what the component needs in order to render a poster, a duration, a
 * size warning and a reorder handle.
 */
export interface VideoItem {
  id: string;
  status: VideoStatus;
  /** Actionable text, set only when `status === 'failed'`. */
  errorMessage: string | null;
  /** Null until `status === 'ready'` — a poster frame cannot exist before
   *  the transcode that produces it has succeeded. That is exactly why a
   *  non-ready video is not a tile. */
  posterUrl: string | null;
  /** Null until `status === 'ready'`. This package never plays a video; it
   *  carries the URL through so a consumer's own player can. */
  videoUrl: string | null;
  durationMs: number | null;
  /** TRANSCODED size in bytes, for the after-upload soft size warning. */
  byteSize: number | null;
  width: number | null;
  height: number | null;
}

/**
 * ONE ordered list — photos and videos interleaved, exactly as the owner
 * arranged them.
 *
 * `media` is the ORDER authority; `imageUrls`/`videos` stay the CONTENT
 * authority. The ARRAY ORDER is the contract and `sortOrder` is
 * informational: the merge must happen SERVER-SIDE and only there,
 * because two clients re-deriving the same `(sort_order, created_at, id)`
 * rule would drift. See `buildMediaTiles` and docs/server-contract.md §8.
 */
export type MediaItem =
  | { type: 'image'; id: string; url: string; sortOrder: number }
  | (VideoItem & { type: 'video'; sortOrder: number });

/**
 * One entry of a combined photo+video reorder request — the full desired
 * order, front to back.
 *
 * `id` is an opaque string here, as everywhere else in this package. A
 * photo id and a video id come from two different tables, so `"10"` is a
 * perfectly possible id for both at once: every lookup is keyed on `type`
 * AND `id`, never the bare id.
 */
export interface MediaOrderItem {
  type: 'image' | 'video';
  id: string;
}

/** Result of a combined reorder. `media` is the server-authoritative
 *  order the grid then renders; omit it and the component keeps its own
 *  optimistic order rather than snapping back. */
export interface MediaOrderResult {
  imageUrls: string[];
  videos: VideoItem[];
  media?: MediaItem[];
}

/** Result of one video upload attempt — the same "resolve, don't reject"
 *  shape as `UploadResult`, for the same reason (a caller uploading
 *  several files in sequence keeps going after one fails). `video` is the
 *  freshly-created row, status 'processing', on success. */
export interface VideoUploadResult {
  fileName: string;
  status: 'success' | 'error';
  error?: string;
  video?: VideoItem;
}

/**
 * The four video operations, injected exactly like `PhotoApi`. Providing
 * this object is the ONLY thing that turns video support on; omit it and
 * the video dropzone, the queue panel, the video tiles and the combined
 * reorder simply do not exist — there is no half-enabled state.
 *
 * NOTHING HERE TRANSCODES. The package accepts a file, hands it to
 * `uploadVideo`, polls `pollVideos`, renders `posterUrl` and lets the user
 * reorder it. No ffmpeg, no codec knowledge, no opinion about your
 * rendition ladder. See docs/server-contract.md §6.
 */
export interface VideoApi {
  /** Upload one video. Expected to answer immediately with a 'processing'
   *  row — a transcode runs far longer than any request should. */
  uploadVideo: (entityId: string, file: File, onProgress: (percent: number) => void) => Promise<VideoUploadResult>;
  deleteVideo: (entityId: string, videoId: string) => Promise<void>;
  /** Every video this entity has, every status. Polled while any row is
   *  still 'processing' — see docs/server-contract.md §7. */
  pollVideos: (entityId: string) => Promise<VideoItem[]>;
  /** Apply a full combined order across photos AND videos. Whole-set, not
   *  pairwise. Read docs/server-contract.md §8 before implementing this:
   *  its completeness rule is the one part of this contract that has
   *  already shipped as a production bug. */
  reorderMedia: (entityId: string, items: MediaOrderItem[]) => Promise<MediaOrderResult>;
}

/**
 * Client-side mirrors of limits your SERVER enforces, used only to warn
 * or reject before a doomed upload starts. Every field is optional and
 * falls back to the documented default (see src/videoLimits.ts).
 *
 * THE SERVER IS THE REAL ENFORCEMENT. These numbers exist to save a round
 * trip and to make the pre-upload estimate honest; a consumer whose server
 * limits differ MUST pass its own values here, or this UI will quietly
 * disagree with what the server will accept.
 */
export interface VideoLimits {
  /** Hard ceiling on the SOURCE file size, in bytes. Default 300 MB. */
  maxBytes?: number;
  /** Hard ceiling on SOURCE duration, in seconds. Default 900 (15 min). */
  maxDurationSeconds?: number;
  /** Soft, informational threshold in bytes — warns, never blocks.
   *  Default 25 MB. */
  sizeWarnBytes?: number;
  /**
   * Measured output rate of your own transcode, for the BEFORE-upload
   * estimate ("this clip will land at roughly N MB"). Default 104_858
   * bytes/second — the origin project's measured 6.0 MB per minute of
   * phone footage at its 720p web rendition.
   */
  estimatedBytesPerSecond?: number;
  /** Containers to accept client-side. Default: mp4, quicktime (iPhone
   *  .mov), x-matroska, webm. Your server's own check is still the real
   *  filter. */
  acceptedMimeTypes?: string[];
}

/**
 * The four API operations MediaUploader needs, injected as props rather
 * than called internally. There is no HTTP client anywhere in this
 * package and never will be — see docs/server-contract.md for what each
 * function's server side must do.
 */
export interface PhotoApi {
  /** Upload one new file for `entityId`, reporting 0-100 progress as it
   *  goes (e.g. via XHR's upload.onprogress — fetch has no built-in
   *  upload-progress event). */
  uploadPhoto: (entityId: string, file: File, onProgress: (percent: number) => void) => Promise<UploadResult>;
  /** Permanently delete one image. */
  deleteImage: (entityId: string, imageId: string) => Promise<void>;
  /** Apply a full reorder: the entity's whole image id set, in the new
   *  order. Whole-set, not pairwise swaps — see docs/server-contract.md's
   *  sort_order section for why. */
  reorderImages: (entityId: string, imageIds: string[]) => Promise<ImageUrlsResult>;
  /** Replace one EXISTING image's bytes in place — same id, same
   *  position. Used by click-to-crop. See docs/server-contract.md's
   *  "replace in place" section for the cache-busting implications. */
  replaceImage: (entityId: string, imageId: string, file: Blob) => Promise<ImageUrlsResult>;
}

// --- Google Photos picker adapter -----------------------------------------
// Optional. See docs/google-photos-setup.md for the full flow and the
// failure modes each of these four functions exists to survive.

/** Result of starting a picker session — a URL to open in a popup, and an
 *  opaque `state` token this same browser tab polls with next. */
export interface GooglePhotosStartResult {
  url: string;
  state: string;
}

/** Poll result for "has the popup's OAuth round trip finished yet?".
 *  `ready: false` means keep waiting. Once `ready: true`, either `error`
 *  is set or `sessionId` is — never both, never neither. */
export interface GooglePhotosBridgePollResult {
  ready: boolean;
  error?: string;
  sessionId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Poll result for "has the admin finished picking inside the popup?". */
export interface GooglePhotosPollResult {
  done: boolean;
  pollIntervalMs: number;
  expired: boolean;
}

/** One picked photo, already converted server-side (see
 *  docs/server-contract.md — the same WebP pipeline a normal upload goes
 *  through). */
export interface GooglePhotosPickedItem {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

/**
 * One picked VIDEO that failed to import — a download-from-Google or
 * enqueue-the-transcode failure. The corresponding video is simply absent
 * from `videos`, never a partial/broken row.
 *
 * `code` selects display text from `labels.googlePhotos.videoErrors`;
 * `message` is your backend's own text, kept ONLY as the honest fallback
 * for a code this package does not know yet. Keep the code set closed
 * server-side: in the origin project a shared pipeline leaked its own
 * unrelated error codes into this field, and every one of them reached
 * the user as untranslated English — the exact bug the field was added
 * to fix.
 */
export interface GooglePhotosVideoImportError {
  fileName: string;
  message: string;
  code?: string;
}

export interface GooglePhotosImportResult {
  photos: GooglePhotosPickedItem[];
  /** Present only when something video-ish was picked. Each row arrives
   *  exactly as `uploadVideo` returns one: a real, server-created
   *  'processing' row. The component folds them into `videos` and the
   *  existing poll takes them to 'ready'/'failed' — no extra machinery. */
  videos?: VideoItem[];
  /** One entry per picked video that failed. Omitted/empty when nothing
   *  video-ish was picked or every video succeeded. */
  videoErrors?: GooglePhotosVideoImportError[];
}

/**
 * The four functions a consumer implements server-side and injects here to
 * enable the "pick from Google Photos" button. Providing this prop is the
 * ONLY thing that turns the feature on — see docs/google-photos-setup.md.
 * Omit it entirely and the button, its hook, and its network calls simply
 * do not exist; there is no broken/disabled state to accidentally ship.
 */
export interface GooglePhotosAdapter {
  /** Begin a picker session. Must return a popup URL and a `state` token
   *  this browser tab can poll with — see docs/google-photos-setup.md for
   *  why polling by state, not postMessage or window.opener. */
  startGooglePhotosPicker: () => Promise<GooglePhotosStartResult>;
  /** Poll for the popup's OAuth round trip finishing. Must send
   *  `Cache-Control: no-store` server-side — see docs/google-photos-setup.md's
   *  failure-modes list. */
  pollGooglePhotosBridge: (state: string) => Promise<GooglePhotosBridgePollResult>;
  /** Poll for the admin finishing their in-popup selection. */
  pollGooglePhotosSession: (sessionId: string) => Promise<GooglePhotosPollResult>;
  /**
   * Fetch the picked items. Photos come back as base64 payloads, already
   * converted server-side. Must NOT delete the session's result on this
   * read — see docs/google-photos-setup.md's failure-modes list for why a
   * retried poll/import must still find it.
   *
   * `entityId` is whatever `MediaUploader` holds AT THE MOMENT OF IMPORT,
   * read fresh rather than captured when the flow started minutes ago. It
   * is `null` before the owning entity's first save. A picked PHOTO never
   * needs it (it comes back as bytes the local upload queue handles), but
   * a picked VIDEO does: your server creates the video row itself, so it
   * needs a parent to attach it to, and must reject the import with
   * `video_needs_saved_parent` when there is none. See
   * docs/google-photos-setup.md's "Importing video".
   */
  importGooglePhotosSession: (sessionId: string, entityId: string | null) => Promise<GooglePhotosImportResult>;
}
