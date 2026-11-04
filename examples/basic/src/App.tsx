import { useMemo, useState } from 'react';
import { MediaUploader } from 'react-mediablock';
import type { MediaItem, VideoItem } from 'react-mediablock';
import { createFakeBackend } from './fakeBackend';

/**
 * The whole point of this example: import the BUILT package, wire it to
 * pure in-memory fakes (no network, no backend), pass NO `googlePhotos`
 * prop, and render. No CSS file beyond `react-mediablock/styles.css` is
 * imported anywhere in this app — every visual token falls back to the
 * package's own built-in defaults. If this looks right, extraction
 * actually worked.
 *
 * It wires up VIDEO as well, because the video half is what a consumer is
 * most likely to implement wrongly, and the fake backend reproduces the
 * three rules that matter: the upload returns a 'processing' row
 * immediately, a non-ready row has no poster and so is not a grid tile, and
 * a reorder validates completeness against photos + READY videos only. See
 * src/fakeBackend.ts and docs/server-contract.md §6-§9.
 */
export function App() {
  const backend = useMemo(() => createFakeBackend(), []);
  // A real app wouldn't hardcode this — it's the id of whatever entity owns
  // this media, null until that entity has been saved once. Hardcoded here
  // since this example has no such entity at all.
  const [entityId] = useState('demo-entity');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  // Starts undefined, exactly as a real app's would before its first
  // server payload: the package then falls back to photos-then-videos until
  // a response carries a real order.
  const [media, setMedia] = useState<MediaItem[] | undefined>(undefined);

  return (
    <main style={{ maxWidth: 760, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>react-mediablock — basic example</h1>
      <p>
        Pick or drag in a few images and a video below. Uploads, delete, reorder, click-to-crop and the whole video
        transcode lifecycle go through the in-memory fake backend in <code>src/fakeBackend.ts</code> — nothing here
        touches a network. No Google Photos configuration is provided, so that button does not render at all.
      </p>
      <p>
        A picked video sits in the queue panel for about three seconds (a fake &ldquo;transcode&rdquo;), then joins
        the grid as a tile you can drag or arrow into any position among the photos. Every 7th video upload fails on
        purpose, so the failed-row retry UI is reachable.
      </p>
      <MediaUploader
        entityId={entityId}
        imageUrls={imageUrls}
        onImageUrlsChange={setImageUrls}
        api={backend.api}
        video={backend.video}
        videos={videos}
        onVideosChange={setVideos}
        media={media}
        onMediaChange={setMedia}
      />
    </main>
  );
}
