/**
 * Shared types for the package's data-in/data-out contract. None of these
 * describe HTTP — they describe the shapes the four injected API functions
 * (uploadPhoto, deleteImage, reorderImages, replaceImage) must return.
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
}

/** Minimal shape reorderImages/replaceImage need to return. Both are
 *  free to return a larger object (e.g. the whole updated entity) — the
 *  component only ever reads `imageUrls` off the result. */
export interface ImageUrlsResult {
  imageUrls: string[];
}

/**
 * The four API operations PhotoUploader needs, injected as props rather
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

export interface GooglePhotosImportResult {
  photos: GooglePhotosPickedItem[];
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
  /** Fetch the picked photos as base64 payloads, already converted
   *  server-side. Must NOT delete the session's result on this read —
   *  see docs/google-photos-setup.md's failure-modes list for why a
   *  retried poll/import must still find it. */
  importGooglePhotosSession: (sessionId: string) => Promise<GooglePhotosImportResult>;
}
