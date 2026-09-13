# Playwright suite

Runs against `e2e/harness/` — a throwaway, dev-only Vite app (never built,
never published) that mounts `PhotoCropEditor` and `PhotoUploader`
standalone with in-memory fakes, at `/crop-editor.html` and
`/photo-uploader.html`. Neither component fetches anything on its own, so
neither harness needs a backend, auth, or an app shell.

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

## What's not ported yet

The origin project's `photo-uploader-crop-queued.spec.ts` (cropping a
photo that's queued but not yet uploaded, decoding the resulting bytes to
confirm the CROPPED pixels — not the original — are what eventually
uploads) was **not ported** to this package. The underlying behavior is
covered by `test/PhotoUploader.test.tsx`'s JSDOM suite (the queue/crop
state machine is exercised there), but the real-browser, decoded-pixel
proof for that specific path does not exist here yet. Flagged honestly
rather than silently dropped — worth adding in a follow-up pass.
