# react-photoblock

A dependency-injected React photo uploader and crop editor: multi-photo
pick/drag upload with per-file progress, drag-and-keyboard reorder,
click-to-crop with 90° rotation, and an optional Google Photos picker
adapter.

**No HTTP client, anywhere.** Every server interaction — upload, delete,
reorder, replace, and (optionally) the Google Photos OAuth flow — is
injected as plain functions. The component makes zero `fetch` calls of its
own. This is the whole design, not an implementation detail: it's what lets
the same two components sit behind any backend, any auth scheme, any
upload endpoint shape, as long as you implement the contract in
[`docs/server-contract.md`](./docs/server-contract.md).

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
in-memory fakes instead of real endpoints.

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

#### `GooglePhotosAdapter`

```ts
interface GooglePhotosAdapter {
  startGooglePhotosPicker: () => Promise<{ url: string; state: string }>;
  pollGooglePhotosBridge: (state: string) => Promise<GooglePhotosBridgePollResult>;
  pollGooglePhotosSession: (sessionId: string) => Promise<GooglePhotosPollResult>;
  importGooglePhotosSession: (sessionId: string) => Promise<GooglePhotosImportResult>;
}
```

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
}): {
  enabled: boolean;
  phase: 'idle' | 'connecting' | 'picking' | 'importing' | 'error';
  error: { code: GooglePhotosErrorCode; detail?: string } | null;
  importedCount: number | null;
  start: () => void;
  cancel: () => void;
  dismissError: () => void;
};
```

`resolveGooglePhotosErrorMessage(error, labels.googlePhotos)` turns an
`error` object into display text using your labels — the hook itself never
produces localized strings, only error codes, so it stays free of any UI
text concerns.

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
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (unit/component, JSDOM)
npm run build       # vite build -> dist/
npm run test:e2e    # playwright (headless Chromium) — requires `npx playwright install chromium` once
```
