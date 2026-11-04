# Server contract

This package draws a hard line: the frontend never talks to a server directly.
`PhotoUploader` takes four functions for photos (`api.uploadPhoto`,
`api.deleteImage`, `api.reorderImages`, `api.replaceImage` — see `PhotoApi` in
`src/types.ts`), optionally four more for video (`video.uploadVideo`,
`video.deleteVideo`, `video.pollVideos`, `video.reorderMedia` — see
`VideoApi`), and calls nothing else. That makes the frontend trivially
portable, but it also means the actual hard part — a correct, safe backend
behind those calls — is entirely your responsibility. This document is the
missing half.

None of this is enforced by the package. It's a specification, written from
a reference implementation that shipped this exact frontend in production.

**Sections 1-5 are the photo contract.** Implement them and the package
works with no video support at all, which is a complete and supported
configuration — omit the `video` prop and the whole video UI does not exist.

**Sections 6-9 are the video and combined-order contract.** §8 and §9 are
the two that have already shipped as production bugs in the reference
implementation. If you read nothing else here, read those.

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

---

# Video

Everything from here on applies only if you inject a `VideoApi`. Omit it and
the package behaves exactly as sections 1-5 describe.

## 6. Transcoding is YOUR job, and the upload must not wait for it

**This package has no codec knowledge and runs no transcode.** It accepts a
video file, hands it to `uploadVideo`, polls `pollVideos`, renders
`posterUrl` and lets the user reorder it. That is the whole of its
involvement, deliberately — it is why the package still has zero runtime
dependencies beyond React.

`uploadVideo` **must answer as soon as the bytes have landed**, with a row
whose `status` is `'processing'`. It must not transcode inside the request.
In the reference implementation a transcode runs at roughly **0.4x
realtime** — measured: 23 seconds of CPU for 60 seconds of 1080p30 — so a
synchronous upload of a three-minute clip is a seven-minute request. Run the
work on a queue and let the row's lifecycle outlive the request.

That lifecycle has exactly three states, and your storage should make the
invalid ones unrepresentable:

| `status`       | `posterUrl` / `videoUrl` / `durationMs` | `errorMessage` |
| -------------- | ---------------------------------------- | -------------- |
| `'processing'` | `null`                                   | `null`         |
| `'ready'`      | all set                                  | `null`         |
| `'failed'`     | `null`                                   | **set**        |

Two constraints behind that table:

- **A `'ready'` row must be fully described.** The package renders
  `posterUrl` into an `<img>` the moment a row reads ready.
- **A restart mid-transcode must leave a row that reads as UNFINISHED**, not
  one that claims to be ready and points at a file that was never written.
  The reference implementation enforces all three rows with CHECK
  constraints rather than application code.

`errorMessage` is rendered verbatim to the person who uploaded the file, so
make it actionable ("not a video", "took too long", "corrupt file") rather
than a stack frame.

### Where the file itself lives is your call, and the poster is not the file

The reference implementation stores the **poster in the database** and the
**video file on a volume**, for reasons worth repeating because they drive
your backup story rather than your code: one minute of phone footage at a
720p web rendition is about 6 MB, so putting video in the database copies it
into every nightly dump and every retained off-site copy, and means
streaming every seek through your application instead of letting your web
server serve byte ranges off a file. Posters are ~36 KB and ride along in
the dump for free, so a restore yields a complete site where every video
shows its real poster in an unavailable state — which names exactly what to
re-upload instead of leaving a silent gap.

### Size and duration limits

The package mirrors three of your limits client-side, **only** to avoid
pushing a doomed file up a phone uplink: `maxBytes`, `maxDurationSeconds`
and a soft `sizeWarnBytes`, plus `estimatedBytesPerSecond` for its
before-upload size estimate. They are **props** (`videoLimits`), not
constants.

**Pass your real numbers.** The reference implementation hardcoded them on
the frontend while the server read them from environment variables, with a
comment admitting that any deployment overriding one would leave the UI
quietly disagreeing with what the server would accept. A package with no
server of its own cannot repeat that, so the defaults are documented
starting values and nothing more.

**Your server is the real enforcement in every case.** A browser's
`file.type` is a guess from the extension and can be an empty string; the
duration probe is a browser metadata read that can simply fail. Both are
round-trip savers, not gates.

## 7. The status poll

`pollVideos(entityId)` returns **every** video the entity has, **every
status**, as an array of rows. The package polls it every 4 seconds while
any row reads `'processing'`, and stops the moment none does — an idle form
makes no requests at all.

- **Include non-ready rows.** They are what the poll is for.
- **Send `Cache-Control: no-store`.** A polled endpoint behind an ETag will
  answer `304` and the row will appear to never finish. (The reference
  implementation hit exactly this on its admin routes.)
- A rejection is swallowed and retried on the next tick, deliberately — a
  transient network blip should leave the row reading `'processing'`, not
  flash an alert.

## 8. The combined media order — READ THIS ONE

`news_images` and `news_videos`, or whatever your two tables are called,
must **share ONE `sort_order` numbering space per parent**. A video at 20
between photos at 10 and 30 is the designed case, not an edge case. The
reference implementation uses a gap of 10 between successive values, and
appends a new row at `GREATEST(max over BOTH tables) + 10`.

### The `media` array

Every endpoint that answers with the whole entity should also return
`media`: ONE array, photos and videos interleaved, in display order.

```jsonc
{
  "imageUrls": ["/images/10?v=1736", "/images/20?v=1736"],
  "videos": [ /* every video, every status */ ],
  "media": [
    { "type": "image", "id": "10", "url": "/images/10?v=1736", "sortOrder": 10 },
    { "type": "video", "id": "5",  "status": "ready", "posterUrl": "...", "sortOrder": 20, /* ...the rest of the row */ },
    { "type": "image", "id": "20", "url": "/images/20?v=1736", "sortOrder": 30 }
  ]
}
```

**The ARRAY ORDER is the contract. `sortOrder` is informational** — the
package carries it and deliberately does not sort on it.

**Merge the two tables server-side and only there.** `sort_order` uniqueness
is not something your schema should enforce (a tie is a state a comparator
must define, not one the schema can rule out), so the merge needs a
tie-breaking rule: the reference implementation uses `sort_order`, then
`created_at`, then photo-before-video, then `id`. Two clients re-deriving
that rule from a comment in a migration **will** drift. `id` must come last
and after the kind clause, because the two tables have independent
sequences and comparing their ids across tables is meaningless.

`created_at` in that rule is load-bearing, not decoration: when two rows
genuinely share a `sort_order` — two append lookups racing on the same
parent can both read the same max — it puts the row that was there first,
first. Drop it and a colliding photo jumps ahead of a video that predates
it, which is a stabler-looking wrong answer than the one you started from.

**`media` is optional.** Omit it and the package falls back to
photos-then-videos, which is correct but cannot express a video between two
photos — so a video tile's arrows will appear to do nothing.

### `reorderMedia`: the completeness rule that shipped as a bug

`reorderMedia(entityId, items)` takes the **entire** new order as
`[{ type, id }, ...]`, front to back. Assign `sort_order = 10, 20, 30, …` in
that order, in one transaction. Same whole-set reasoning as §3.

Validate it in two separate halves, because they have different answers:

**MEMBERSHIP — keep at full strength. This is a security boundary.** Reject
any id that does not belong to this parent, and reject duplicates. A video
id from somebody else's post must not be reorderable into yours.

**COMPLETENESS — validate against photos + READY videos, NOT all videos.**

This is the bug. The reference implementation required the payload to name
every photo and every video, and **a `'processing'` or `'failed'` video has
no poster, so the grid deliberately never shows it** — the package renders
those in a separate queue panel and therefore *cannot* submit them. The
result: while any clip was transcoding, which is minutes, **every drag of
every tile failed completeness and was rejected and reverted.** The owner's
report was "why can't I move the tile, independent of what's going on in
the background?".

Note precisely which rule changed. A submitted non-ready id is still
rejected, because it means the client's view disagrees with your database.
If the grid ever starts rendering non-ready videos, this set has to widen
with it.

**Then renumber the non-ready videos to the TAIL**, after every submitted
item, keeping their order among themselves. Not optional: the main loop
rewrites positions `10..n*10`, and a non-ready video still holds whatever
number the append gave it — which may now collide with that range (delete a
photo and the renumber hands out 10, 20 while the clip sits at 40; with five
photos it hands out 10..50 and lands on it). A tie then resolves on
`created_at`, which the user can neither see nor change, so the clip would
surface at an unpredictable spot when it finished. Putting it at the tail
means the rule the user learns is the one they already know from uploading:
when the transcode finishes, the clip is at the end.

## 9. `media` must come back from EVERY mutation, not just the reorder

The package applies a fresh `media` on **six** paths. The reference
implementation shipped it applied on the reorder only, and a freshly
uploaded photo then appeared in the wrong place and **moved by itself on
reload** — a server order of `[P1, V1, P2]` rendered as `[P1, V1, V2, P2]`
as soon as a second video existed.

| Path                 | Your response                     | What the package does                            |
| -------------------- | --------------------------------- | ------------------------------------------------- |
| photo upload         | whole entity, **incl. `media`**   | applies it                                        |
| crop / replace       | whole entity, **incl. `media`**   | applies it                                        |
| combined reorder     | whole entity, **incl. `media`**   | applies it, overriding its optimistic guess       |
| photo delete         | no body (204)                     | derives: drops that entry                         |
| video upload         | the one new row                   | derives: folds the row in at the tail             |
| video delete         | no body (204)                     | derives: drops that entry                         |
| status poll          | the rows                          | derives: keeps each row's existing position       |

So: **if your endpoint returns the entity, return `media` with it.** The
three derived paths need nothing from you. A delete answering 204 with no
body is fine and expected — the package removes the entry itself, which
matters because its optimistic reorder deliberately preserves entries it
finds no tile for, and a stale deleted entry would otherwise be resurrected
as a phantom.

## 10. Reference SQL for video

Illustrative, same caveat as §5.

```sql
CREATE TABLE videos (
    id            BIGSERIAL PRIMARY KEY,
    owner_type    TEXT        NOT NULL,
    owner_id      BIGINT      NOT NULL,
    -- ONE numbering space with the images table above. See §8.
    sort_order    INTEGER     NOT NULL,
    status        TEXT        NOT NULL,
    -- The transcoded file's location on your media volume. NOT in the
    -- database — see §6.
    storage_key   TEXT,
    -- The poster DOES live here: ~36KB, and it is what makes a restore
    -- name what to re-upload instead of leaving a silent gap.
    poster_data   BYTEA,
    error_message TEXT,
    duration_ms   INTEGER,
    width         INTEGER,
    height        INTEGER,
    byte_size     BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The three-state table in §6, made unrepresentable-if-wrong rather
    -- than enforced in application code. A restart mid-transcode then
    -- cannot leave a row that claims to be ready.
    CONSTRAINT videos_status_known
        CHECK (status IN ('processing', 'ready', 'failed')),
    CONSTRAINT videos_ready_is_complete
        CHECK (status <> 'ready' OR (storage_key IS NOT NULL
                                     AND poster_data IS NOT NULL
                                     AND duration_ms IS NOT NULL)),
    CONSTRAINT videos_failed_has_reason
        CHECK (status <> 'failed' OR error_message IS NOT NULL)
);

CREATE INDEX videos_owner_order_idx
    ON videos (owner_type, owner_id, sort_order, created_at, id);
```

Poster and file URLs are built the same content-addressed way as §4:

```
posterUrl: `/api/videos/${id}/poster?v=${updated_at epoch ms}`
videoUrl:  `/api/videos/${id}/file.mp4`
```

The `?v=` token matters on the poster for the same reason it matters on a
cropped photo: the id does not change when the bytes do.

## 11. Google Photos video import

Only if you implement the Google Photos adapter (see
`docs/google-photos-setup.md`). Two things belong here rather than there:

- `importGooglePhotosSession(sessionId, entityId)` receives the entity id
  the package holds **at the moment of import**, or `null`. A picked photo
  comes back as bytes and never needs it; a picked **video** does, because
  your server creates the row itself. With no parent, reject the whole
  import with `code: 'video_needs_saved_parent'` — the package has its own
  message for that code, which says "save first", instead of a generic
  failure.
- Per-item video failures go in `videoErrors: [{ fileName, message, code }]`
  alongside a successful response's `videos`. **Keep that code set closed.**
  The reference implementation typed `code` as a bare `string` and passed a
  shared pipeline's own error codes straight through, so codes that knew
  nothing about Google Photos reached the user as untranslated English — the
  exact bug the field was added to fix. The codes this package has text for
  are `video_not_ready`, `video_too_large`, `video_download_failed`,
  `video_processing_failed`, `video_too_long` and `video_queue_full`;
  anything else falls back to your own `message`.
