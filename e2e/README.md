# Playwright suite

Runs against `e2e/harness/` — a throwaway, dev-only Vite app (never built,
never published) that mounts `PhotoCropEditor` and `PhotoUploader`
standalone with in-memory fakes, at `/crop-editor.html`,
`/photo-uploader.html` and `/video-uploader.html`. Nothing in the package
fetches on its own, so no harness needs a backend, auth, or an app shell.

```sh
npx playwright install chromium   # once
npm run test:e2e
```

## What's covered

- **`photo-crop-editor.spec.ts`** (32 tests) — the real-browser layout
  invariant this whole component depends on (the image's rendered box
  exactly fills the crop stage, at every aspect ratio and rotation),
  ground-truth pixel verification of an actual crop and an actual rotation
  (decoding the real saved Blob, not asserting against a `drawImage`
  call's arguments), the output-resolution cap, the responsive stage on a
  narrow viewport, the dimming layer staying confined to the stage, and
  the corner handles staying hit-testable after that dimming split. This
  is the file that proves what JSDOM structurally cannot — see the
  package README's Limitations section.
- **`photo-uploader-focus.spec.ts`** (1 test) — a real-Chromium-only
  finding: a keyboard reorder move that disables the just-used button also
  blurs it, and `PhotoUploader`'s refocus effect has to compensate. JSDOM
  has no such focus-management behavior to reproduce, so this is
  Playwright-only.
- **`photo-uploader-video.spec.ts`** (7 tests) — two claims JSDOM
  structurally cannot make.

  The first is the grid's **painted** order: "the video sits between the
  two photos" is a statement about x-coordinates, and document order is a
  different claim — an `order`, `column-reverse` or grid change could
  separate them with the DOM untouched. So the helper sorts tiles by their
  measured boxes, never by document order. Plus a poster that really
  decodes (`naturalWidth > 0`, which a 404, a 401 or an omitted `src` all
  leave at 0 while the element still looks present), and a processing video
  that is not a tile at all.

  The second is the play disc's **proportion**. The origin project's first
  attempt at "a disc that scales with its tile" used a `clamp()` whose
  floor bound on small cells and ceiling on large ones, which INVERTED the
  intent — and absolute-pixel assertions are exactly how that passed
  review. These specs measure the ratio of disc width to the tile's short
  side at 120px and 500px, and then assert the two ratios are equal **to
  each other**. Mutation-proven: restoring the inverted clamp yields 0.317
  and 0.176, and all three assertions go red; removing
  `container-type: size` (so `cqmin` escapes the tile) also kills them.
  Both tile sizes sit inside the band where the share decides rather than
  where a clamp bound binds — a size where one binds would mask the very
  inversion the specs exist to catch.

## What's not ported yet

The origin project's `photo-uploader-crop-queued.spec.ts` (cropping a
photo that's queued but not yet uploaded, decoding the resulting bytes to
confirm the CROPPED pixels — not the original — are what eventually
uploads) was **not ported** to this package. The underlying behavior is
covered by `test/PhotoUploader.test.tsx`'s JSDOM suite (the queue/crop
state machine is exercised there), but the real-browser, decoded-pixel
proof for that specific path does not exist here yet. Flagged honestly
rather than silently dropped — worth adding in a follow-up pass.
