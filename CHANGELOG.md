# Changelog

All notable changes to this package are documented here. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

First published release. `0.1.0` existed only inside the repository and was
never on npm, so if you are installing this package for the first time,
everything below is simply what you get.

### Photos and video in one gallery

The component now accepts **video alongside photos**, in a single
drag-and-keyboard-reorderable grid, and the arrangement can interleave the
two — a video between two photos is representable and persists.

Video is **entirely opt-in**: pass a `video` adapter (`uploadVideo`,
`deleteVideo`, `pollVideos`, `reorderMedia`) and you get a second dropzone,
a before-upload size warning, a transcode-status queue panel, video tiles
in the grid, and one reorder across both media types. Omit it and none of
that exists — there is no half-enabled state.

**Your server transcodes; this package has no codec knowledge at all.** It
hands a file to your `uploadVideo`, polls your `pollVideos` until the
status moves, renders the poster URL you return, and lets the user reorder
it. That boundary is why the package still has zero runtime dependencies
beyond React.

Three new props carry the combined ordering:

- `media` / `onMediaChange` — the server's one ordered list, and the
  **order authority**. `imageUrls` and `videos` remain the *content*
  authority. `media` is optional; omit it and you get photos-then-videos,
  which is correct but cannot place a video between two photos, because
  `imageUrls: string[]` carries no position for a video to occupy.
- `videos` / `onVideosChange` — every video the entity has, in **every**
  status, as full rows.
- `videoLimits` — client-side mirrors of **your server's** limits, so a
  doomed file is not pushed up a phone uplink first. Pass your real
  numbers; your server stays the actual enforcement.

A `processing` or `failed` video has no poster, so it is never a grid tile
— it appears in the queue panel instead.

If you implement the video adapter, read
[`docs/server-contract.md`](./docs/server-contract.md) §6–§9 first. The
completeness rule in §8 and the six response paths in §9 are each a bug
that shipped once in the application this package was extracted from.

### New: `loadImage`, for images behind a request header

**An `<img src>` cannot send a header.** If your thumbnails are served from
an endpoint behind `Authorization: Bearer …`, pointing an `<img>` at them
makes every thumbnail 401.

The new optional `loadImage` prop takes `(src: string) => Promise<Blob> | null`
— fetch the bytes yourself and the component renders them; return `null`
for any URL you would rather it loaded directly. Omit the prop entirely and
every image is a plain `<img>`, exactly as before.

The package never learns what a token is. Two things worth knowing:
**memoize it** (it is a dependency of the fetching effect, so a fresh
identity every render re-fetches every thumbnail), and it is **never**
called for the package's own local `blob:`/`data:` previews, so instant
previews cannot be broken by routing them through an auth layer.

A token in the query string is not the alternative — reverse proxies log
full request lines, which writes a live credential into the access log.

### Renamed

The package gained video, so photo-specific naming became inaccurate.
Everything below is a rename only: no behaviour changed with it.

| Before                | After                 |
| --------------------- | --------------------- |
| `react-photoblock`    | `react-mediablock`    |
| `PhotoUploader`       | `MediaUploader`       |
| `PhotoUploaderProps`  | `MediaUploaderProps`  |
| `PhotoUploaderLabels` | `MediaUploaderLabels` |
| `PhotoBlockLabels`    | `MediaBlockLabels`    |
| `--pb-*` CSS tokens   | `--mblock-*`          |

```diff
-import { PhotoUploader } from 'react-photoblock';
-import 'react-photoblock/styles.css';
+import { MediaUploader } from 'react-mediablock';
+import 'react-mediablock/styles.css';
```

**`PhotoCropEditor` keeps its name**, as do `PhotoCropEditorProps`,
`PhotoCropEditorLabels`, `PhotoApi` and `api.uploadPhoto`. These operate on
images and only images; calling them `Media*` would promise video editing
that does not exist.

### Also in this release

- **Type declarations are now a single rolled-up `dist/index.d.ts`.** The
  previous per-module layout used extensionless relative imports, which
  TypeScript rejects under `moduleResolution: node16`/`nodenext` for a
  `"type": "module"` package — with `skipLibCheck: true` (the common
  setting) the symptom was worse than an error: every export silently
  degraded to `any`. Types now bind correctly under `bundler`, `node16`
  and `nodenext`.
- `MIT` is now backed by an actual `LICENSE` file in the published
  tarball.
- `repository`, `homepage`, `bugs` and `author` added to `package.json`.
- Published sourcemaps are self-contained (`sourcesContent` embedded), so
  stepping into the package in devtools shows real source.
