import { useMemo, useState } from 'react';
import { PhotoUploader } from 'react-photoblock';
import { createFakeApi } from './fakeApi';

/**
 * The whole point of this example: import the BUILT package, wire it to
 * pure in-memory fakes (no network, no backend), pass NO `googlePhotos`
 * prop, and render. No CSS file beyond `react-photoblock/styles.css` is
 * imported anywhere in this app — every visual token falls back to the
 * package's own built-in defaults. If this looks right, extraction
 * actually worked.
 */
export function App() {
  const api = useMemo(() => createFakeApi(), []);
  // A real app wouldn't hardcode this — it's the id of whatever "News
  // post" or "Project" (or your own equivalent) owns these photos, null
  // until that entity has been saved once. Hardcoded here since this
  // example has no such entity at all.
  const [entityId] = useState('demo-entity');
  const [imageUrls, setImageUrls] = useState<string[]>([]);

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>react-photoblock — basic example</h1>
      <p>
        Pick or drag in a few images below. Uploads, delete, reorder, and click-to-crop all go through the in-memory
        fake API in <code>src/fakeApi.ts</code> — nothing here touches a network. No Google Photos configuration is
        provided, so that button does not render at all.
      </p>
      <PhotoUploader entityId={entityId} imageUrls={imageUrls} onImageUrlsChange={setImageUrls} api={api} />
    </main>
  );
}
