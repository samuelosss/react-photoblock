import { useState } from 'react';
import { PhotoCropEditor } from '../../../src/components/PhotoCropEditor';

/**
 * Playwright-only harness — mounts PhotoCropEditor standalone with no data
 * fetching of its own (it only ever takes imageUrl/saving/onCancel/onSave),
 * so it needs no app shell, no auth, no backend. This is what lets
 * e2e/photo-crop-editor.spec.ts exercise the component in a REAL browser
 * with a real layout engine — JSDOM (used by test/PhotoCropEditor.test.tsx)
 * has none, so it cannot observe a CSS `max-width` clamp or actual paint,
 * both of which matter to this component (see its own module doc).
 *
 * The fixture image comes from `?src=` (an e2e/harness/public/e2e-fixtures/
 * *.svg — SVG so a known, exact intrinsic width/height needs no binary
 * image generation; real browsers report `naturalWidth`/`naturalHeight` for
 * an SVG `<img>` from its `width`/`height` attributes, same as any raster
 * format).
 *
 * Outcome is exposed as plain text in a labelled element so a spec can read
 * it with a normal Playwright locator, no special test API:
 *   - after Save: "saved:<blob size>:<blob type>"
 *   - after Cancel/Close: "cancelled"
 *
 * The saved blob's actual BYTES are also stashed on
 * `window.__lastSavedDataUrl` (a data: URL, via FileReader) — the outcome
 * text only proves a Blob of some size/type came out, not that its PIXELS
 * are the ones actually selected. A spec that wants ground truth decodes
 * this back through the browser's own image decoder (createImageBitmap)
 * and reads real pixels.
 */
export function CropEditorHarness() {
  const params = new URLSearchParams(window.location.search);
  const src = params.get('src') ?? '';
  const [outcome, setOutcome] = useState('');

  async function handleSave(blob: Blob) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    (window as unknown as { __lastSavedDataUrl?: string }).__lastSavedDataUrl = dataUrl;
    setOutcome(`saved:${blob.size}:${blob.type}`);
  }

  return (
    <div>
      <PhotoCropEditor
        imageUrl={src}
        saving={false}
        onCancel={() => setOutcome('cancelled')}
        onSave={(blob) => void handleSave(blob)}
      />
      <p aria-label="harness outcome">{outcome}</p>
    </div>
  );
}
