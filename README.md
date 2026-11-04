# react-photoblock

A dependency-injected React **media authoring block**: pick or drag in
photos and videos, watch them upload with per-file progress, arrange them
in **one combined gallery** by drag or keyboard, click any photo to
crop/rotate it, and (optionally) import from Google Photos.

Not a public gallery and not a player — this is the **authoring** side: the
component someone edits a post or a project with.

### What it deliberately does not do

**Your server transcodes. This package has no codec knowledge at all.** For
video it accepts a file, hands it to your `uploadVideo`, polls your
`pollVideos` until the status moves, renders the poster URL you give back,
and lets the user reorder it. No ffmpeg, no rendition ladder, no opinion
about containers beyond a MIME filter you can replace. That line is why
"zero runtime dependencies" is still true with video in the box.

**No HTTP client, anywhere.** Every server interaction — upload, delete,
reorder, replace, the video lifecycle, and the Google Photos OAuth flow —
is injected as plain functions. The components make zero `fetch` calls of
their own. This is the whole design, not an implementation detail: it's
what lets them sit behind any backend, any auth scheme, any endpoint shape,
as long as you implement the contract in
[`docs/server-contract.md`](./docs/server-contract.md).

**It doesn't know what a bearer token is**, either. If your thumbnails sit
behind a header an `<img src>` cannot send, you inject
[`loadImage`](#loading-images-that-need-a-request-header). Omit it and
every image is a plain `<img>`.

**Zero runtime dependencies beyond React**, which is a peer dependency, not
bundled.

## Install

```sh
npm install react-photoblock
```

```tsx
import { PhotoUploader } from 'react-photoblock';
import 'react-photoblock/styles.css';
```

## Minimal working example

```tsx
import { useState } from 'react';
import { PhotoUploader } from 'react-photoblock';
import 'react-photoblock/styles.css';
import type { PhotoApi } from 'react-photoblock';

const api: PhotoApi = {
  async uploadPhoto(entityId, file, onProgress) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/entities/${entityId}/images`, { method: 'POST', body: form });
    const data = await res.json();
    onProgress(100);
    return { fileName: file.name, status: 'success', imageUrls: data.imageUrls };
  },
  async deleteImage(entityId, imageId) {
    await fetch(`/api/entities/${entityId}/images/${imageId}`, { method: 'DELETE' });
  },
  async reorderImages(entityId, imageIds) {
    const res = await fetch(`/api/entities/${entityId}/images/order`, {
      method: 'PUT',
      body: JSON.stringify({ imageIds }),
    });
    return res.json();
  },
  async replaceImage(entityId, imageId, blob) {
    const form = new FormData();
    form.append('file', blob);
    const res = await fetch(`/api/entities/${entityId}/images/${imageId}`, { method: 'PUT', body: form });
    return res.json();
  },
};

function MyForm() {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  return <PhotoUploader entityId="42" imageUrls={imageUrls} onImageUrlsChange={setImageUrls} api={api} />;
}
```

None of the four functions above is a real, complete implementation — see
[`docs/server-contract.md`](./docs/server-contract.md) for what your
backend actually needs to do (WebP conversion, HEIC handling, `sort_order`,
content-addressed URLs). Getting that part wrong is the most likely way
this package looks broken while the frontend code is fine.

See [`examples/basic/`](./examples/basic) for a complete, runnable app with
in-memory fakes instead of real endpoints — including the video lifecycle,
faked end to end (a "transcode" that takes a few seconds and then produces
a poster), so you can see the queue panel, the status poll and the combined
reorder working without a backend.

### Adding video

```tsx
const video: VideoApi = {
  async uploadVideo(entityId, file, onProgress) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/entities/${entityId}/videos`, { method: 'POST', body: form });
    onProgress(100);
    // 202 + a 'processing' row. Do NOT transcode inside this request.
    return { fileName: file.name, status: 'success', video: await res.json() };
  },
  async deleteVideo(entityId, videoId) {
    await fetch(`/api/entities/${entityId}/videos/${videoId}`, { method: 'DELETE' });
  },
  async pollVideos(entityId) {
    const res = await fetch(`/api/entities/${entityId}/videos`, { cache: 'no-store' });
    return res.json(); // every video, every status
  },
  async reorderMedia(entityId, items) {
    const res = await fetch(`/api/entities/${entityId}/media/order`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    });
    return res.json(); // { imageUrls, videos, media }
  },
};

<PhotoUploader
  entityId={entityId}
  imageUrls={imageUrls}
  onImageUrlsChange={setImageUrls}
  api={api}
  video={video}
  videos={videos}
  onVideosChange={setVideos}
  media={media}
  onMediaChange={setMedia}
  videoLimits={{ maxBytes: 300 * 1024 * 1024, maxDurationSeconds: 900 }}
/>;
```

The hard parts are all on the other side of those four functions. §6-§9 of
[`docs/server-contract.md`](./docs/server-contract.md) is not optional
reading if you implement them.

## Props

### `<PhotoUploader />`

| Prop                | Type                                                              | Required | Notes                                                                                                                     |
| -------------------- | ------------------------------------------------------------------ | :------: | --------------------------------------------------------------------------------------------------------------------------- |
| `entityId`          | `string \| null`                                                  |    Yes   | `null` before the owning entity (a post, a project, whatever owns these photos) has ever been saved. See below.          |
| `imageUrls`         | `string[]`                                                        |    Yes   | Current image URLs, in display order. Each must end in `/images/<id>` (optionally `?query`) — see `docs/server-contract.md`. |
| `onImageUrlsChange` | `(urls: string[]) => void`                                        |    Yes   | Called whenever the list changes (upload, delete, reorder, crop-replace).                                                 |
| `api`               | [`PhotoApi`](#photoapi)                                            |    Yes   | The four server operations.                                                                                               |
| `onQueueStateChange`| `(state: { pending: boolean; hasErrors: boolean }) => void`       |    No    | Fires as the upload queue changes — use it to block navigation while uploads are in flight or have failed.                |
| `googlePhotos`      | [`GooglePhotosAdapter`](#googlephotosadapter) \| `undefined`      |    No    | Provide all four functions to enable "Choose from Google Photos"; omit entirely to disable it. See [the setup guide](./docs/google-photos-setup.md). |
| `labels`            | `DeepPartial<PhotoBlockLabels>`                                    |    No    | Override any subset of the UI text — see [Labels & theming](#labels--theming) below.                                      |
| `loadImage`         | `(src: string) => Promise<Blob> \| null`                          |    No    | Fetch image bytes yourself, for an endpoint an `<img src>` can't reach. See [below](#loading-images-that-need-a-request-header). Absent = plain `<img>`. **Memoize it.** |
| `video`             | [`VideoApi`](#videoapi) \| `undefined`                            |    No    | The four video operations. Providing this is the **only** thing that turns video support on. |
| `videos`            | `VideoItem[]`                                                     |    No    | Every video this entity has, **every status**. Mirrors `imageUrls`, but as full rows.      |
| `onVideosChange`    | `(videos: VideoItem[]) => void`                                   |    No    | Called whenever that list changes (upload, delete, status poll, reorder).                  |
| `media`             | `MediaItem[]`                                                     |    No    | The server's ONE ordered list — the **order authority**. See [below](#one-combined-gallery-media-vs-imageurls). |
| `onMediaChange`     | `(media: MediaItem[]) => void`                                    |    No    | **Required for a moved video to stick.** See below.                                        |
| `videoLimits`       | [`VideoLimits`](#videolimits)                                     |    No    | Client-side mirrors of **your server's** limits. Pass your real numbers.                   |
| `estimateVideoDurationSeconds` | `(file: File) => Promise<number \| null>`              |    No    | Defaults to a real `<video>` metadata probe. Injectable mainly so tests don't need a decoder. |

**About `entityId` being `null`:** `PhotoUploader` works from the moment a
"new" form opens, before anything has been saved. Pick files while
`entityId` is `null` and they queue locally (instant preview, nothing
uploaded, no draft entity created just to get an id); the moment your app
passes a real `entityId` (after the user's first save), everything queued
uploads automatically, in the order it was picked. If your form always has
a real id from the start, this doesn't change anything — files upload
immediately either way.

#### `PhotoApi`

```ts
interface PhotoApi {
  uploadPhoto: (entityId: string, file: File, onProgress: (percent: number) => void) => Promise<UploadResult>;
  deleteImage: (entityId: string, imageId: string) => Promise<void>;
  reorderImages: (entityId: string, imageIds: string[]) => Promise<ImageUrlsResult>;
  replaceImage: (entityId: string, imageId: string, file: Blob) => Promise<ImageUrlsResult>;
}
```

Full contract, including what your server needs to do for each of these to
be correct: [`docs/server-contract.md`](./docs/server-contract.md).

#### `VideoApi`

```ts
interface VideoApi {
  uploadVideo: (entityId: string, file: File, onProgress: (percent: number) => void) => Promise<VideoUploadResult>;
  deleteVideo: (entityId: string, videoId: string) => Promise<void>;
  pollVideos: (entityId: string) => Promise<VideoItem[]>;
  reorderMedia: (entityId: string, items: MediaOrderItem[]) => Promise<MediaOrderResult>;
}
```

Supply it and you get a second dropzone, a before-upload size warning, a
transcode-status queue panel, video tiles in the same grid as the photos,
and one reorder across both. Omit it and none of that exists — there is no
half-enabled state.

**`uploadVideo` must return immediately with a `'processing'` row**, not
wait for a transcode. In the reference implementation a transcode runs at
roughly 0.4x realtime, so a three-minute clip is a seven-minute request.
`pollVideos` is how the component learns it finished; it polls every 4
seconds while any row is `'processing'` and stops the moment none is.

A `'processing'` or `'failed'` video has no poster, so it is **never** a
grid tile — it renders in the queue panel instead. Read
[`docs/server-contract.md`](./docs/server-contract.md) §6-§9 before
implementing this; §8's completeness rule and §9's six paths are each a bug
that shipped once.

#### `VideoLimits`

```ts
interface VideoLimits {
  maxBytes?: number;                  // default 300 MB
  maxDurationSeconds?: number;        // default 900
  sizeWarnBytes?: number;             // default 25 MB — soft, never blocks
  estimatedBytesPerSecond?: number;   // default ~104.9 KB/s (6 MB per minute, measured at 720p)
  acceptedMimeTypes?: string[];       // default mp4, quicktime, x-matroska, webm
}
```

**Pass your own numbers.** These only exist so a doomed file isn't pushed
up a phone uplink first; your server is the real enforcement in every case.
The reference implementation hardcoded them on the frontend while the
server read them from env vars, and any deployment overriding one left the
UI quietly disagreeing with what the server would accept.

#### One combined gallery: `media` vs `imageUrls`

`media` is the **ORDER** authority. `imageUrls` and `videos` are the
**CONTENT** authority. Anything `media` doesn't mention is appended to a
fallback tail.

The reason is that `imageUrls: string[]` carries no position, so *no*
arrangement with a video between two photos is representable in it. Before
`media` existed in the reference implementation, the grid could only derive
"photos in order, then videos in order": pressing an arrow on a video tile
fired the handler, the server stored the new order, and the response
re-derived the same list and snapped the tile straight back.

Content stays with `imageUrls`/`videos` because they're fresher between
round trips — an upload returns only `imageUrls`, a crop returns a fresh
`?v=` on the same id, a delete removes a row, a poll flips
`processing`→`ready`.

**`media` must come back from every mutation that returns the entity, not
just the reorder.** The reference implementation applied it on reorder
only, and a freshly uploaded photo then appeared in the wrong place and
moved by itself on reload. The six paths are tabulated in
[`docs/server-contract.md`](./docs/server-contract.md) §9.

`media` is optional: omit it and you get photos-then-videos, which is
correct but cannot place a video between two photos.

#### Loading images that need a request header

**An `<img src>` cannot send a header.** If your thumbnails are served from
an endpoint behind `Authorization: Bearer …` — because the person editing a
draft must see photos the public cannot — pointing an `<img>` at those URLs
makes every thumbnail 401 and render broken.

**A token in the query string is not the alternative.** `?token=…` looks
like the easy fix and isn't: reverse proxies log full request lines, so it
writes a live credential into the access log, where it outlives the session
and the person who issued it. nginx's default `combined` format does this,
and so does almost every other proxy's. The header is the only place that
value belongs.

So inject the fetch. The package never learns what a token is:

```tsx
const loadImage = useCallback(
  (src: string) =>
    src.startsWith('/api/')
      ? fetch(src, { headers: { Authorization: `Bearer ${token}` } }).then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.blob();
        })
      : null, // not mine — render it as a plain <img src>
  [token],
);
```

- **Return `null`** for any URL you don't want to handle; it renders
  directly. That matters in a mixed app where some images are public.
- **Never called for the package's own local previews** (`blob:`/`data:`
  URLs it created from a picked file) — routing those through an auth layer
  would break instant previews. That exclusion is structural, not something
  you have to remember.
- **Caching is not lost**: `fetch()` honours the HTTP cache, so keep your
  URLs content-addressed (§4's `?v=` token) and send a long
  `Cache-Control` on those routes.
- **Memoize it.** It's a dependency of the effect that fetches, so a fresh
  identity every render re-fetches every thumbnail every render.

#### `GooglePhotosAdapter`

```ts
interface GooglePhotosAdapter {
  startGooglePhotosPicker: () => Promise<{ url: string; state: string }>;
  pollGooglePhotosBridge: (state: string) => Promise<GooglePhotosBridgePollResult>;
  pollGooglePhotosSession: (sessionId: string) => Promise<GooglePhotosPollResult>;
  importGooglePhotosSession: (sessionId: string, entityId: string | null) => Promise<GooglePhotosImportResult>;
}
```

The picker handles **photos and video through the same button** — Google's
own picker has no media-type filter to configure that away. `entityId` is
whatever the component holds at the moment of import, read fresh; a picked
photo never needs it, but a picked video does, because your server creates
the row. With no saved parent, reject the import with
`code: 'video_needs_saved_parent'` and the component says "save first"
rather than showing a generic failure.

Full guide, including the OAuth setup and the failure modes worth knowing
about first: [`docs/google-photos-setup.md`](./docs/google-photos-setup.md).

### `<PhotoCropEditor />`

`PhotoUploader` renders this internally for click-to-crop, but it's
exported standalone too — it takes no `api`, no `entityId`, nothing
server-related at all; it just turns a picked crop/rotation into a Blob.

| Prop       | Type                                       | Required | Notes                                                          |
| ---------- | ------------------------------------------- | :------: | ---------------------------------------------------------------- |
| `imageUrl` | `string`                                    |    Yes   | The image to edit.                                              |
| `saving`   | `boolean`                                   |    Yes   | Disables the controls while `true`, so a double-click can't fire two saves. |
| `onCancel` | `() => void`                                |    Yes   | Called on Cancel/Close, Escape, or a backdrop click.             |
| `onSave`   | `(blob: Blob) => void`                      |    Yes   | Called with the final cropped/rotated image, encoded as WebP.    |
| `labels`   | `DeepPartial<PhotoCropEditorLabels>`        |    No    | See below.                                                       |

### `useGooglePhotosPicker`

The hook `PhotoUploader` uses internally, exported in case you want to
build your own UI around the Google Photos flow instead of the built-in
button:

```ts
function useGooglePhotosPicker(options: {
  adapter?: GooglePhotosAdapter; // undefined disables the whole hook
  onPhotosReady: (files: File[]) => void;
  entityId?: string | null;      // read fresh at import time; a picked VIDEO needs it
  onVideosReady?: (videos: VideoItem[], errors: GooglePhotosVideoImportError[]) => void;
}): {
  enabled: boolean;
  phase: 'idle' | 'connecting' | 'picking' | 'importing' | 'error';
  error: { code: GooglePhotosErrorCode; detail?: string } | null;
  imported: { photos: number; videos: number; failedVideos: number } | null;
  start: () => void;
  cancel: () => void;
  dismissError: () => void;
};
```

`resolveGooglePhotosErrorMessage(error, labels.googlePhotos)` turns an
`error` object into display text using your labels, and
`resolveGooglePhotosVideoErrorMessage(entry, labels.googlePhotos)` does the
same for one per-item video failure — the hook itself never produces
localized strings, only error codes, so it stays free of any UI text
concerns.

`imported` is a shape rather than a count because a single import can land
photos, land videos and fail on other videos all at once.

## Labels & theming

### Labels

Every visible string and every `aria-label` in this package comes from a
`labels` prop — nothing is hardcoded. The full default set is in English
(`defaultLabels`, exported); a complete Czech translation is shipped as a
ready-made preset (`csLabels`, the language this package's components
originally shipped with in production):

```tsx
import { PhotoUploader, csLabels } from 'react-photoblock';

<PhotoUploader labels={csLabels} /* ...other props */ />;
```

Override a single string without retyping the rest — overrides merge onto
the default one field deep (two deep for `googlePhotos.errors`):

```tsx
<PhotoUploader labels={{ uploader: { dropzoneIdle: 'Drop your photos here!' } }} /* ... */ />;
```

The full shape is `PhotoBlockLabels` (`{ uploader, cropEditor, googlePhotos }`,
each fully typed) — see [`src/labels.ts`](./src/labels.ts) for every field
and what renders it; every visible piece of copy in the package traces back
to exactly one field there.

### Theming

Every color/spacing/typography value is a CSS custom property, namespaced
`--pb-*`, with a sensible fallback baked into every single `var()` call —
this is why the package looks correct with zero configuration (see
`examples/basic/`, which defines none of these). Override any subset by
setting these on an ancestor element (or `:root`):

| Token                    | Default fallback              | Used for                                                        |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `--pb-accent`             | `#e8622c`                     | Focus rings, crop-rectangle border and handles                    |
| `--pb-success`            | `#2f9e44`                     | Upload progress fill, dropzone idle text, Save button, success text |
| `--pb-danger`             | `#b3261e`                     | Error text and status                                              |
| `--pb-primary`            | `#2a2a72`                     | Retry/edit button text                                             |
| `--pb-surface`            | `#ffffff`                     | Card/dialog/button background                                      |
| `--pb-surface-alt`        | `#f3f4f6`                     | Progress track background, active-drag dropzone background         |
| `--pb-surface-tint`       | `#eef2f7`                     | Hover background (Google Photos button)                            |
| `--pb-border`             | `#d8dbe0`                     | Borders                                                             |
| `--pb-text`               | `#1a1a1a`                     | Body text                                                           |
| `--pb-text-muted`         | `#6b7280`                     | Hints, secondary text                                              |
| `--pb-on-overlay`         | `#ffffff`                     | Icon/text color on the dark circular overlay buttons and crop handle border |
| `--pb-overlay`            | `rgba(17, 17, 17, 0.82)`      | Dark circular delete/move-button background over thumbnails        |
| `--pb-scrim`              | `rgba(0, 0, 0, 0.65)`         | Crop editor's full-screen modal backdrop                           |
| `--pb-stage-bg`           | `#111111`                     | Crop stage background behind a transparent-region image            |
| `--pb-radius`             | `8px`                         | Standard corner radius                                             |
| `--pb-space-1`            | `4px`                         | Small gaps                                                          |
| `--pb-space-2`            | `8px`                         | Standard gaps                                                       |
| `--pb-space-3`            | `16px`                        | Dialog padding                                                      |
| `--pb-font-size-sm`       | `0.875rem`                    | Secondary text size                                                 |
| `--pb-font-weight-accent` | `600`                         | Emphasized text weight (dropzone label, buttons)                    |

No CSS framework required — this is plain CSS Modules, compiled to one
stylesheet (`dist/react-photoblock.css`), imported via
`react-photoblock/styles.css`.

## Server contract

The highest-value part of this package and, historically, the hardest to
discover just by reading the frontend code. Full write-up, including
reference SQL: [`docs/server-contract.md`](./docs/server-contract.md).
Short version:

1. **Convert every upload to WebP server-side**, capped at the same pixel
   dimension this package's own crop editor caps its output at
   (`MAX_OUTPUT_DIMENSION_PX`, `2400` — the two numbers must move
   together, see the doc for why).
2. **Decode HEIC before your image library sees it** — most image
   libraries' bundled decoders can't read HEIC directly (a phone's default
   photo format); this is the single most likely thing to bite you.
3. **An explicit, gapped `sort_order` column**, and reordering as a
   whole-set replacement, not pairwise swaps.
4. **Replace-in-place, keeping the same id**, plus **content-addressed
   URLs** (`?v=<updated_at>`) so a long-lived immutable cache header
   doesn't serve stale bytes after a crop.

And, if you wire up video (§6-§9):

5. **Transcode on a queue; answer the upload immediately** with a
   `'processing'` row. A `'ready'` row must be fully described and a
   restart mid-transcode must leave a row that reads as unfinished.
6. **One shared `sort_order` space across photos and videos**, merged
   server-side into a `media` array whose **array order is the contract**.
7. **Validate a reorder's completeness against photos + READY videos** —
   never against all videos. The grid cannot submit a row it deliberately
   never shows, so the reference implementation rejected *every* reorder
   while any clip was transcoding. Keep membership (no foreign ids, no
   duplicates) at full strength; that part is a security boundary.
8. **Return `media` from every mutation that returns the entity.** Six
   paths need it; applying it on the reorder alone is a bug that shipped.

## Google Photos picker

Fully optional. Provide all four adapter functions to enable the "Choose
from Google Photos" button; provide none and it doesn't exist — no dead
control, no console warning, no partial state. Setup guide (OAuth client,
scopes, redirect URI) and the four real failure modes this flow ran into in
production (popup.closed lying, cache headers on polled endpoints,
delete-on-read, COOP severing `window.opener`):
[`docs/google-photos-setup.md`](./docs/google-photos-setup.md). Never wire
a client secret into anything this package touches — the frontend half of
this flow has no legitimate use for one, by construction.

`.env.example` at the repo root documents the three variables a **backend**
implementing the adapter needs (client id, client secret, redirect URI) —
no values, safe to commit. `.gitignore` excludes the real `.env`.

## Limitations

Read this before you ship anything visual against a target you haven't
tested yourself.

- **Verified in headless Chromium only.** The unit suite runs under
  JSDOM (no layout engine, no real paint — see below); the Playwright
  suite (`e2e/`) runs in headless Chromium. Neither is Firefox, neither is
  WebKit-via-Playwright.
- **No video has ever been transcoded behind this package's tests.** Every
  video path is exercised against injected fakes, which is the honest
  consequence of the design — the package has no transcode to test. What
  that leaves unverified is the *contract*: a real server that answers
  `uploadVideo` synchronously, or omits `media` from an upload response, or
  validates a reorder against all videos, will misbehave in ways this
  suite cannot see. [`docs/server-contract.md`](./docs/server-contract.md)
  §6-§9 is the only thing standing between you and those bugs, and each of
  them shipped once in the implementation it was written from.
- **The real `<video>` duration probe is unexercised.** JSDOM never fires
  `loadedmetadata`, so every test injects
  `estimateVideoDurationSeconds`. The default implementation's own
  behaviour against a real file — including a corrupt one, where it must
  resolve `null` rather than hang — has not been tested here.
- **`container-type: size`** (which the play affordance's `cqmin` sizing
  depends on) needs Safari 16+ / Chrome 106+ / Firefox 110+. Below that the
  `clamp()` on the preceding line takes over: same shape, sized from the
  tile's width instead of its short side, which is identical while the tile
  is square and drifts if you override `.photo`'s aspect ratio.
- **macOS Safari (WebKit)**: exercised manually by a human, and working —
  including dragging the crop handles and saving. **There is no automated
  WebKit coverage.** Playwright's WebKit browser isn't installed in this
  package's CI/dev setup, so nothing in the suite guards WebKit against a
  future regression; a change that breaks it there would go green
  everywhere this repo actually tests.
- **iOS Safari**: unverified.
- **Touch input**: unverified on real hardware. Playwright's `page.mouse`
  synthesizes pointer events, not a thumb — whether a 20px corner handle
  sitting half outside the image is comfortably grabbable with a finger is
  genuinely unknown. Worth checking early if your consumers are mostly on
  phones.
- **JSDOM cannot see layout or paint.** `test/PhotoCropEditor.test.tsx`
  mocks `clientWidth`/`clientHeight` to values the component's own math
  computed — it proves the component's wiring calls the right pure
  functions with the right arguments, never that a real browser lays the
  result out the way the math assumes. Only `e2e/photo-crop-editor.spec.ts`
  (Playwright) proves that, via real `boundingBox()` measurements and
  actual decoded pixels from the saved Blob.
- **The `2400px` output cap only matches a backend built to the same cap.**
  If you change your server's resize dimension, change
  `MAX_OUTPUT_DIMENSION_PX` (exported from this package) to match — see
  `docs/server-contract.md`.
- **No test coverage claims beyond what's in this repo's own `test/` and
  `e2e/` directories.** This README does not claim anything was verified
  that wasn't actually run — see the gates section below for the real
  numbers.

### Two things worth knowing if you're debugging this component

1. **Hard-reload after deploying a change to it.** Both WebKit symptoms
   that briefly looked like real bugs during this package's own
   development — crop handles rendering offset from the image, and the
   dialog dismissing when it shouldn't — turned out to be a stale cached
   bundle, not a real defect; they disappeared after a hard reload. If a
   user reports either symptom, the first question is whether they're
   actually running the build they think they are.
2. **The dimming shadow and the crop rectangle are deliberately separate
   elements** (`.dimClip`/`.dimRect` vs `.cropRect` in
   `PhotoCropEditor.module.css`). Don't merge them, and don't add
   `overflow: hidden` to `.stage` to contain the shadow — either change
   breaks the corner handles' hit area, because the handles sit half
   outside the stage on purpose (so a corner stays grabbable when cropping
   flush to an image edge). This has been rediscovered the hard way more
   than once; the CSS module's own comments explain the full reasoning.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit over src, test and e2e
npm run lint        # eslint
npm test            # vitest (unit/component, JSDOM) — 178 tests
npm run build       # tsc + vite build -> dist/ (the published artefact)
npm run test:e2e    # playwright (headless Chromium) — 40 specs; `npx playwright install chromium` once
```

`npm run build` is a gate, not a convenience: `files: ["dist"]` means a
broken build ships a broken package in a way no test catches.
