# Google Photos picker setup

This package can offer a "Choose from Google Photos" button, but it ships
**zero Google integration by default** — no credentials, no Google URLs, no
`fetch` calls to any Google API, anywhere in `src/`. The feature turns on
only when you pass a `googlePhotos` adapter (four functions) to
`PhotoUploader`. Omit it and the button, the hook that drives it, and every
network call it would make simply do not exist — there is no
disabled/broken state to accidentally ship.

**The client secret never reaches this package, by construction.** All four
adapter functions are implemented by YOUR server; the frontend only calls
them and receives already-processed results (a picker URL, poll booleans, an
already-imported photo). There is no field anywhere in this package's
`props` or `types.ts` for a client secret, because the frontend half of this
flow has no legitimate use for one.

## What you're building

A full round trip through Google's own OAuth consent screen, running in a
popup window, orchestrated by four endpoints on your own backend:

```
 Browser tab                Your backend                 Google
──────────────              ─────────────              ──────────
1. click "Choose
   from Google Photos"
      │
      ▼
2. startGooglePhotosPicker()
   ─────────────────────────▶ builds an OAuth URL,
                               returns { url, state }
      │
      ▼
3. window.open(url) ──────────────────────────────────▶ consent screen
      │                                                       │
      │  (tab polls pollGooglePhotosBridge(state)              │
      │   every ~1.5s while the popup does its own thing)      │
      │                                                        ▼
      │                       4. your OAuth callback route  ◀── redirect with code
      │                          exchanges the code for a
      │                          token, opens a Google
      │                          Photos Picker session,
      │                          stores { sessionId } keyed
      │                          by `state`
      ▼
5. pollGooglePhotosBridge(state) eventually
   returns { ready: true, sessionId }
      │
      ▼
6. pollGooglePhotosSession(sessionId) polls
   until the user finishes picking inside
   the popup's own Google Photos picker UI
      │
      ▼
7. importGooglePhotosSession(sessionId)
   ─────────────────────────▶ downloads the picked
                               items from Google,
                               runs them through YOUR
                               own image pipeline (see
                               docs/server-contract.md),
                               returns base64 payloads
      │
      ▼
8. useGooglePhotosPicker turns those into real
   File objects and hands them to onPhotosReady
```

Steps 2, 5, 6, and 7 are the four adapter functions. Steps 3-4 (the popup,
the OAuth redirect, your callback route) are entirely server-side and not
part of this package at all — your backend needs its own route that Google
redirects back to.

## The four function signatures

From `src/types.ts` (`GooglePhotosAdapter`):

```ts
interface GooglePhotosAdapter {
  startGooglePhotosPicker: () => Promise<{ url: string; state: string }>;
  pollGooglePhotosBridge: (state: string) => Promise<{
    ready: boolean;
    error?: string;      // set when ready && something went wrong
    sessionId?: string;  // set when ready && it succeeded
    pollIntervalMs?: number;
    timeoutMs?: number;
  }>;
  pollGooglePhotosSession: (sessionId: string) => Promise<{
    done: boolean;
    pollIntervalMs: number;
    expired: boolean;
  }>;
  importGooglePhotosSession: (sessionId: string) => Promise<{
    photos: Array<{ fileName: string; contentType: string; dataBase64: string }>;
  }>;
}
```

- **`startGooglePhotosPicker`** — your server builds the Google OAuth
  authorize URL (with your client id, scopes, and a redirect URI pointing
  at your own callback route) and generates an opaque, unguessable `state`
  token. Store `state` server-side, associated with nothing yet. Return
  both to the browser.
- **`pollGooglePhotosBridge`** — polls for "has the popup's OAuth round
  trip finished?". Your OAuth callback route (hit by Google's redirect, not
  by this package) is what actually resolves this: on success it opens a
  [Google Photos Picker API](https://developers.google.com/photos/picker/guides/get-started-picker)
  session and stores `{ sessionId }` keyed by `state`; on failure it stores
  an error code keyed by the same `state`. This function just reads that
  stored result back. `ready: false` means "keep waiting"; `ready: true`
  means a terminal result exists (`error` or `sessionId`, never both).
- **`pollGooglePhotosSession`** — polls the Picker API session itself for
  "has the user finished selecting items in the popup?". Proxy this to
  Google's own session-status endpoint.
- **`importGooglePhotosSession`** — once picking is done, fetch the
  selected media items from Google, run them through your own image
  pipeline (WebP conversion etc. — see `docs/server-contract.md`), and
  return them as base64 payloads. The frontend turns these into real `File`
  objects via `base64ToFile` (exported from this package) and feeds them
  into the same upload queue a locally-picked file goes through.

## Google Cloud setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project, then **APIs & Services → Library** and enable the
   **Google Photos Picker API**.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   type **Web application**.
3. Add an **Authorized redirect URI** pointing at your backend's OAuth
   callback route, e.g. `https://your-api.example.com/photos/google/callback`.
   This must match, character for character, what your backend passes as
   `redirect_uri` when building the authorize URL in
   `startGooglePhotosPicker`.
4. Note the **Client ID** and **Client secret**. Put them in your backend's
   environment (see `.env.example` at the repo root) — **never in any
   frontend bundle, build config, or code path this package touches.**
5. **Scopes**: request only
   `https://www.googleapis.com/auth/photospicker.mediaitems.readonly` — the
   narrowest scope that lets a user pick and your backend download the
   items they chose. Do not request broader Photos Library scopes you don't
   need.
6. If your OAuth consent screen is in "Testing" mode, only the test users
   you explicitly add can complete the flow — everyone else sees an access
   error at Google's consent screen, which looks identical to a
   misconfiguration from this package's side. Check this first if a real
   user reports the picker "not working" during development.

## Failure modes worth knowing about before you hit them

These cost real debugging time in the project this package was extracted
from. Reading this section first is cheaper than rediscovering all four.

### `popup.closed` lies

`window.open()` returns a `Window` handle, and it's tempting to poll
`popup.closed` to detect "the user gave up." **Don't rely on it.** Once the
popup navigates through Google's own consent screen, Cross-Origin-Opener-
Policy headers on Google's pages (or a browser privacy feature — Brave's
Shields was the common factor across every report of this in the wild) can
sever the popup from its opener. When that happens, `popup.closed` can
report `true` while the window is still open and the user is still actively
using it — a false positive that, if acted on, silently resets the whole
flow to idle with no error shown. That's indistinguishable from "nothing
happened," which is exactly what a broken picker looks like to a user.

This package's `useGooglePhotosPicker` deliberately never checks
`popup.closed` for this reason. It relies entirely on the server-side poll
result plus its own local timeout, and exposes an explicit `cancel()` for a
genuine "I give up."

### Polled endpoints need `Cache-Control: no-store`

`pollGooglePhotosBridge` and `pollGooglePhotosSession` are hit repeatedly,
every ~1.5s, from the same browser tab. If a reverse proxy or CDN sits in
front of your API and caches GET responses by default, the FIRST poll
response (`{ ready: false }`) can get cached and served back for every
subsequent poll — the flow hangs forever, because the browser never sees
the real "ready" result even after your backend has it. Set
`Cache-Control: no-store` explicitly on both polling endpoints' responses.

### Never delete-on-read a polled result

It's tempting to have `pollGooglePhotosBridge` or the session-poll delete
its stored result the moment it reports success, on the theory that it's
"been delivered." Don't — a retried request (a flaky connection, a browser
tab that momentarily loses focus and its `fetch` gets cancelled and retried)
then finds nothing and the flow hangs with no way to recover except
starting over. Expire results by TTL instead of by first-read, and make a
repeated read of an already-consumed result idempotent (return the same
data again) rather than empty.

### COOP severs `window.opener` — this is why there's a server-side bridge at all

An earlier version of the reference implementation tried
`window.opener.postMessage(...)` to send the result straight from the popup
back to the opener tab, and later tried `BroadcastChannel` as a same-origin
alternative. Both failed in real testing: `postMessage` because
Cross-Origin-Opener-Policy on Google's own pages severs `window.opener`
partway through the OAuth round trip (the popup successfully reaches and
completes Google's UI, but the opener tab never hears back), and
`BroadcastChannel` because a browser privacy feature partitioning storage
across that same cross-origin navigation appears to silently drop delivery
in practice, even though it doesn't depend on `window.opener` at all.

The fix that actually works: **poll same-origin, by an opaque `state`
value the tab already has from before the popup even opened.** That's why
`startGooglePhotosPicker` returns `state` up front, and why
`pollGooglePhotosBridge` takes it as an argument — the browser tab never
needs anything FROM the popup at all; it just asks its own backend "is
`state` done yet?" on a plain interval, the same way every other request in
your app already works, immune to whatever a browser does with cross-window
messaging APIs.

## Testing the flow end to end without a real Google account

For local development, you can implement all four adapter functions
against fixtures instead of Google's real APIs (return a fake `url`/`state`
from `startGooglePhotosPicker`, have `pollGooglePhotosBridge` resolve
`ready: true` after a short delay, etc.) to exercise `PhotoUploader`'s UI
states (connecting → picking → importing → idle, plus each error code) —
see `examples/basic/` in this repo for a working in-memory fake of the
whole `GooglePhotosAdapter` interface, alongside fakes for the upload API.
