# Basic example

The real test of whether this package's extraction actually worked: a
minimal app that imports the **built** `react-photoblock` package, wires it
to pure in-memory fakes for the four `PhotoApi` functions (see
`src/fakeApi.ts`), passes no `googlePhotos` adapter, and imports no CSS
beyond `react-photoblock/styles.css`. If this renders correctly, the
package has zero hidden dependencies on its origin application.

## Run it

From this directory:

```sh
npm install   # resolves react-photoblock via the file: dependency in package.json,
              # which points at ../.. — build that package first (npm run build
              # from the repo root) or this will import a stale/missing dist/.
npm run dev   # http://localhost:5173
```

## What to look for

- The dropzone, upload queue, and photo grid all render with the package's
  **default** visual styling — no `--pb-*` custom properties are defined
  anywhere in this example, so what you see is entirely the fallback
  values baked into the package's own CSS.
- No "Choose from Google Photos" button — this example passes no
  `googlePhotos` prop.
- Picking a file queues it, "uploads" it through the in-memory fake (a
  short artificial delay + progress, see `src/fakeApi.ts`), and it appears
  in the grid — clicking it opens the crop editor, which also needs no
  network.

## Automated check

`npm run test:e2e` (Playwright, headless Chromium) drives exactly the
scenario above — computed-style border check (proves the CSS fallback
values apply, not just that classes exist), no Google Photos button, and a
picked file reaching the photo grid — against the built preview server.
