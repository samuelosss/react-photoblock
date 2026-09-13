# Server contract

This package draws a hard line: the frontend never talks to a server directly.
`PhotoUploader` takes four functions (`api.uploadPhoto`, `api.deleteImage`,
`api.reorderImages`, `api.replaceImage` — see `PhotoApi` in `src/types.ts`) and
calls nothing else. That makes the frontend trivially portable, but it also
means the actual hard part — a correct, safe backend behind those four calls
— is entirely your responsibility. This document is the missing half.

None of this is enforced by the package. It's a specification, written from
a reference implementation that shipped this exact frontend in production.

## 1. WebP conversion, server-side

Convert every uploaded image to WebP on the server, always, with no
exceptions for "it's already a modern format" — a consistent output format
is what lets you reason about storage size and set one `Content-Type`
policy everywhere. The reference implementation uses
[sharp](https://sharp.pixelplumbing.com/) with:

- **A 2400px cap on the longest side** (`resize({ width: 2400, height: 2400,
  fit: 'inside', withoutEnlargement: true })`).
- **Quality 82** (`webp({ quality: 82 })`) — a reasonable default; tune to
  taste.

### This number has to match `MAX_OUTPUT_DIMENSION_PX`

`PhotoCropEditor` caps its own crop output at **2400px** on the longest side
before encoding (see `MAX_OUTPUT_DIMENSION_PX`, exported from the package)
— **this must be the same number as your server's own resize cap.** The two
are not connected by any shared import (this is a frontend-only package with
no knowledge of your backend), so keeping them equal is on you.

Why this matters, concretely: a modern phone photo is commonly 10-12
megapixels. Encoding a full-resolution crop of that client-side, uploading
it, decoding it server-side, and immediately downsizing it to 2400px is
pure waste — measured on the reference implementation, a full 4000×3000
crop took **~1.6 seconds and ~1.4MB** to encode uncapped, versus **~0.6
seconds and ~0.6MB** capped at 2400px, for a **pixel-identical final
result** once the server's own resize ran either way. Capping client-side
isn't a quality tradeoff; it's removing work that gets thrown away anyway.

Getting the two numbers out of sync has a real, asymmetric cost:

- **Client cap lower than server cap**: you throw away quality the server
  was willing to keep. A smaller image doesn't get upscaled back up by
  anything — the server only ever shrinks, never enlarges — so this is a
  strictly worse image for no benefit.
- **Client cap higher than server cap**: pure waste, the exact problem
  above. Every pixel beyond the server's cap is encoded client-side,
  uploaded, decoded server-side, and discarded.

If you change your server's resize cap, change `MAX_OUTPUT_DIMENSION_PX`'s
value on the frontend side to match (it isn't a prop — it's a build-time
constant, because the two numbers must never silently drift apart via
runtime configuration).

## 2. HEIC input needs a decode step before sharp

**This is the single most likely thing to bite you if you accept uploads
from a phone's camera roll.** iPhones save photos as HEIC by default. sharp
is built on libvips, and the prebuilt libvips binaries sharp ships **do not
include an HEIC decoder** (it's excluded for licensing reasons in most
distributions). Handing sharp a `.heic` file directly throws, not warns.

The reference implementation shells out to the system `heif-convert`
(part of `libheif`, typically installed via `apt install libheif-examples`
or your distro's equivalent) to decode HEIC to a temporary PNG/JPEG
**before** handing it to sharp. Pseudocode:

```
if (mimeType is HEIC/HEIF or filename ends in .heic/.heif):
    run `heif-convert input.heic input.png`
    feed input.png to sharp instead of the original upload
```

Verify `heif-convert` is actually installed in whatever environment runs
your upload handler — it is easy to have it on a dev machine and discover
it's missing in a container image only when the first phone upload fails in
production.

## 3. `sort_order` and reordering as a whole-set operation

Store an explicit `sort_order` (or similar) integer column alongside each
image row, and order query results by `ORDER BY sort_order, created_at, id`
(the trailing tie-breakers matter: two images can legitimately share a
`sort_order` after certain edits, and without a stable tie-break the
displayed order can flicker between requests).

**Leave gaps between values** (10, 20, 30, ...) rather than 1, 2, 3 — this
lets you insert a new image between two existing ones (`sort_order = 15`)
without renumbering anything else. Append new uploads at
`max(sort_order) + 10` (or `10` if the entity has no images yet).

**`api.reorderImages(entityId, imageIds)` takes the ENTIRE new order, not a
pairwise swap.** `PhotoUploader` always sends the complete id list in its
new order — both drag-and-drop and the keyboard move buttons compute a full
new array and pass all of it. Implement this server-side as: given the
ordered id list, assign `sort_order = 10, 20, 30, ...` in that order, in one
transaction. Do NOT implement it as "swap the sort_order of these two rows"
— a whole-set replacement is simpler to reason about, handles a drag that
moves an item across several positions in one request, and can't drift out
of sync with what the client actually displayed.

## 4. Replace-in-place and content-addressed URLs

`api.replaceImage(entityId, imageId, blob)` (used by click-to-crop) must
replace an image's BYTES while keeping its id and its position in the
`sort_order` sequence unchanged. Do not delete-and-recreate — that would
also require a client-side reorder to restore position, for no reason.

**Your image URLs must be content-addressed**, e.g.
`/images/<id>?v=<updated_at as epoch milliseconds>`. This is not optional
if you also set a long, immutable cache header (which you should — image
bytes for a given id rarely change, so `Cache-Control: public, max-age=31536000,
immutable` is the right policy *most* of the time). The problem
replace-in-place creates: the URL `/images/42` never changes across a crop
edit, because the id and position are deliberately preserved — so a browser
(or CDN) holding that URL under a long-lived immutable cache header will
keep serving the PRE-crop bytes forever unless something about the URL
itself changes.

The fix is to bump `updated_at` on every `replaceImage` call and fold it
into the URL as a query parameter (`?v=<epoch ms>`). `PhotoUploader` never
does any client-side cache-busting itself — it trusts that
`api.replaceImage`'s returned `imageUrls` already carry the new `?v=`, and
re-renders the `<img src>` with that new URL, which the browser treats as a
different resource. Skip this and a cropped photo will appear to silently
"not save" to anyone with the old version already cached — one of the more
confusing classes of bug to debug after the fact, since the server-side data
is actually correct.

## 5. Reference SQL

Illustrative, not a migration runner — adapt column types/naming to your
own schema conventions.

```sql
-- One row per image. `owner_type`/`owner_id` is one way to let this table
-- serve more than one kind of parent entity (a "News post" and a
-- "Project" in the reference implementation, for instance) without a
-- separate images table per entity type — use a plain FK instead if you
-- only ever have one owner type.
CREATE TABLE images (
    id            BIGSERIAL PRIMARY KEY,
    owner_type    TEXT        NOT NULL,
    owner_id      BIGINT      NOT NULL,
    sort_order    INTEGER     NOT NULL,
    bytes         BYTEA       NOT NULL,       -- or a blob-storage reference/URL, your call
    content_type  TEXT        NOT NULL DEFAULT 'image/webp',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ORDER BY this index supports directly.
CREATE INDEX images_owner_order_idx
    ON images (owner_type, owner_id, sort_order, created_at, id);

-- Bump updated_at automatically on any UPDATE (Postgres has no built-in
-- ON UPDATE clause the way MySQL does) — every replaceImage() call then
-- gets a fresh ?v= for free without the application layer having to
-- remember to set it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER images_touch_updated_at
    BEFORE UPDATE ON images
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

A typical `GET` for one owner:

```sql
SELECT id, content_type, updated_at
FROM images
WHERE owner_type = $1 AND owner_id = $2
ORDER BY sort_order, created_at, id;
```

Build each URL as `` `/images/${id}?v=${Math.floor(updated_at.getTime())}` ``
(or your framework's epoch-millis equivalent) when mapping rows to the
`imageUrls` array every `PhotoApi` method returns.
