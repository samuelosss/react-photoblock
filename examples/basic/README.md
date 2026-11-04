# Basic example

The real test of whether this package's extraction actually worked: a
minimal app that imports the **built** `react-mediablock` package, wires it
to pure in-memory fakes for the `PhotoApi` and `VideoApi` functions (see
`src/fakeBackend.ts`), passes no `googlePhotos` adapter, and imports no CSS
beyond `react-mediablock/styles.css`. If this renders correctly, the
package has zero hidden dependencies on its origin application.

`src/fakeBackend.ts` is worth reading even if you never run this app. It is
a deliberately faithful miniature of `docs/server-contract.md` §6-§9: the
video upload answers immediately with a `'processing'` row and lets the
"transcode" finish on its own clock, a non-ready row carries no poster,
photos and videos share ONE position space, and `reorderMedia` validates
membership strictly while validating completeness against photos + READY
videos only. Each of those is a rule the reference implementation learned
by shipping it wrong.

It does **not** transcode anything, because transcoding is the server's job
and this is a fake server. Its posters are drawn, not extracted — the one
place pretending otherwise would actively mislead.

## Run it

From this directory:

```sh
npm install   # resolves react-mediablock via the file: dependency in package.json,
              # which points at ../.. — build that package first (npm run build
              # from the repo root) or this will import a stale/missing dist/.
npm run dev   # http://localhost:5173
```

## What to look for

- The dropzone, upload queue, and photo grid all render with the package's
  **default** visual styling — no `--mblock-*` custom properties are defined
  anywhere in this example, so what you see is entirely the fallback
  values baked into the package's own CSS.
- No "Choose from Google Photos" button — this example passes no
  `googlePhotos` prop.
- Picking a photo queues it, "uploads" it through the in-memory fake (a
  short artificial delay + progress, see `src/fakeBackend.ts`), and it
  appears in the grid — clicking it opens the crop editor, which also
  needs no network.
- Picking a video shows it in the **queue panel** for about three seconds
  (the fake "transcode"), with no grid tile, because a processing row has
  no poster yet. Then the status poll picks it up and it joins the grid as
  a tile you can drag or arrow into any position **among the photos** —
  the arrangement `imageUrls: string[]` cannot express at all.
- Every 7th video upload "fails" on purpose, so the failed-row retry and
  delete controls are reachable rather than being a path nobody ever sees.
- A video longer than ~4 minutes trips the soft size warning before the
  upload starts, with an explicit "Upload anyway". It never blocks.

## Automated check

`npm run test:e2e` (Playwright, headless Chromium, 2 specs) drives the
scenarios above against the built preview server: a computed-style border
check (which proves the CSS fallback values actually apply, not merely that
the classes exist), no Google Photos button, a picked photo reaching the
grid, and a picked video going queue-panel -> grid tile across the fake
transcode.
