import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Rotation } from '../src/components/cropMath';

/**
 * The Playwright regression for PhotoCropEditor's central layout invariant:
 * JSDOM has no layout engine, so it cannot observe a CSS `max-width` clamp
 * — which is exactly the class of bug that can silently reintroduce a
 * letterbox gap between the stage and the image at 90°/270° for a
 * landscape source (see PhotoCropEditor.module.css's `.image` rule and
 * cropMath.ts's own module doc for the full derivation). The JSDOM suite
 * in test/PhotoCropEditor.test.tsx mocks `clientWidth`/`clientHeight` to
 * the value the component's OWN math computes, so it structurally cannot
 * catch a disagreement between that math and what a real browser actually
 * renders — this file is what can.
 *
 * Harness: /crop-editor.html?src=... mounts PhotoCropEditor standalone
 * (e2e/harness/src/CropEditorHarness.tsx) — no backend, since the
 * component takes only imageUrl/saving/onCancel/onSave as props.
 */

interface Fixture {
  name: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

const PORTRAIT: Fixture = { name: 'portrait', src: '/e2e-fixtures/portrait-1800x2400.svg', naturalWidth: 1800, naturalHeight: 2400 };
const LANDSCAPE: Fixture = { name: 'landscape', src: '/e2e-fixtures/landscape-2400x1800.svg', naturalWidth: 2400, naturalHeight: 1800 };
const SQUARE: Fixture = { name: 'square', src: '/e2e-fixtures/square-1000x1000.svg', naturalWidth: 1000, naturalHeight: 1000 };
const RATIO_16_9: Fixture = { name: '16:9', src: '/e2e-fixtures/ratio16x9-1920x1080.svg', naturalWidth: 1920, naturalHeight: 1080 };
const WIDE_SOURCE: Fixture = { name: 'wide 4000x3000 source', src: '/e2e-fixtures/landscape-4000x3000.svg', naturalWidth: 4000, naturalHeight: 3000 };
/**
 * Four solid-colour quadrants (red/green/blue/yellow), used ONLY by the
 * ground-truth crop test below — see that test's own comment for why a
 * colour fixture, not a shared math helper, is what proves the crop is
 * actually correct.
 */
const QUADRANTS: Fixture = { name: 'quadrants', src: '/e2e-fixtures/quadrants-400x300.svg', naturalWidth: 400, naturalHeight: 300 };
/**
 * Same red/green/blue/yellow layout as QUADRANTS, scaled 12x so its full
 * frame is 4800x3600 — deliberately chosen so that, after a 90° rotation
 * (see the resolution-cap tests below), the ROTATED full-frame region is
 * exactly 3600x4800: longest side 4800, exactly 2x MAX_OUTPUT_DIMENSION_PX
 * (2400), so the capped output is exactly 1800x2400 with no rounding
 * ambiguity — no tolerance needed on the dimension assertion itself.
 */
const QUADRANTS_OVER_CAP: Fixture = { name: 'quadrants (over cap)', src: '/e2e-fixtures/quadrants-4800x3600.svg', naturalWidth: 4800, naturalHeight: 3600 };

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

async function gotoHarness(page: Page, fixture: Fixture) {
  await page.goto(`/crop-editor.html?src=${encodeURIComponent(fixture.src)}`);
  const img = page.locator('img[alt=""]');
  await expect(img).toBeVisible();
  // Wait for the (SVG, always-fast, but still async) image load to reach
  // the component's onLoad — the crop rect only renders once it has.
  await expect(page.locator('[class*="cropRect"]')).toBeVisible();
}

async function rotateTo(page: Page, target: Rotation) {
  const steps = target / 90;
  for (let i = 0; i < steps; i++) {
    await page.getByRole('button', { name: 'Rotate right 90°' }).click();
  }
}

function closeBox(a: number, b: number, tolerance = 1.5) {
  expect(Math.abs(a - b), `expected ${a} to be within ${tolerance}px of ${b}`).toBeLessThanOrEqual(tolerance);
}

/**
 * Ground truth for what a real browser actually PAINTED at (x, y) — a
 * `box-shadow` is composited on top of an element's own background, so
 * nothing in `getComputedStyle` reflects it either way; this is exactly
 * the class of paint-only fact JSDOM cannot see at all (no paint engine).
 * Takes a real 1x1 screenshot at the page coordinate, then decodes it back
 * through the BROWSER's own PNG decoder (`createImageBitmap`) rather than
 * a hand-rolled Node-side PNG parser — one less thing to get subtly wrong,
 * and it's the same decoder that would paint the pixel on screen in the
 * first place.
 */
async function pixelColorAt(page: Page, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const [r, g, b] = await page.evaluate(async (dataUrl) => {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, `data:image/png;base64,${png.toString('base64')}`);
  return { r: r!, g: g!, b: b! };
}

test.describe("PhotoCropEditor — the stage IS the image's box, in a real browser", () => {
  for (const fixture of [PORTRAIT, LANDSCAPE, SQUARE, RATIO_16_9]) {
    for (const rotation of ROTATIONS) {
      test(`${fixture.name} at ${rotation}° — img.boundingBox() equals stage.boundingBox()`, async ({ page }) => {
        await gotoHarness(page, fixture);
        await rotateTo(page, rotation);

        const stage = page.locator('[class*="_stage_"]');
        const img = page.locator('img[alt=""]');
        const stageBox = await stage.boundingBox();
        const imgBox = await img.boundingBox();
        expect(stageBox).not.toBeNull();
        expect(imgBox).not.toBeNull();

        // THE single invariant the entire crop-region computation rests
        // on: the image's rendered box must exactly fill the stage, zero
        // letterbox gap on any edge — this is what a CSS max-width clamp
        // (or any other layout bug) would break, and it is real, laid-out
        // pixels, not a mocked clientWidth.
        closeBox(imgBox!.x, stageBox!.x);
        closeBox(imgBox!.y, stageBox!.y);
        closeBox(imgBox!.width, stageBox!.width);
        closeBox(imgBox!.height, stageBox!.height);
      });
    }
  }

  /**
   * A test that computed its expectation by importing the component's own
   * `resizeCropRect`/`computeCropPixelRegion` and asserting the
   * `drawImage` call agreed with THEM would be tautological — both sides
   * move together under a shared bug. Instead: crop a known 4-quadrant
   * colour fixture (red/green/blue/yellow) to a region that straddles
   * BOTH quadrant midlines, then decode the ACTUAL SAVED BLOB (not a
   * drawImage() call arguments capture) and check its real pixels. This
   * is ground truth no shared helper can launder: a bug in ANY of x/y/
   * width/height moves at least one of the four sampled corners into the
   * wrong quadrant's colour, and a bug in the image-vs-stage sizing (the
   * OTHER thing this suite guards, see the block above) would size the
   * output canvas wrong regardless of which pixels end up in it.
   */
  test('cropping a known region actually cuts that pixel content — ground truth, independent of cropMath', async ({ page }) => {
    await gotoHarness(page, QUADRANTS);

    const stage = page.locator('[class*="_stage_"]');
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();

    // Drag the "se" handle inward by an ARBITRARY fraction of the real,
    // measured stage box — 30% off the right edge, 20% off the bottom —
    // chosen so the resulting crop straddles both the fixture's vertical
    // AND horizontal midlines (where red/green/blue/yellow meet), landing
    // each of the four OUTPUT corners in a different quadrant's colour.
    const handle = page.locator('[class*="handle-se"]');
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    const dxFraction = 0.3;
    const dyFraction = 0.2;
    const dxPx = stageBox!.width * dxFraction;
    const dyPx = stageBox!.height * dyFraction;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - dxPx, startY - dyPx, { steps: 8 });
    await page.mouse.up();

    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(page.getByLabel('harness outcome')).toHaveText(/^saved:/);

    const dataUrl = await page.evaluate(
      () => (window as unknown as { __lastSavedDataUrl?: string }).__lastSavedDataUrl,
    );
    expect(dataUrl, 'harness did not stash a data URL for the saved blob').toBeTruthy();

    // Decoded by the BROWSER's own image decoder (createImageBitmap),
    // same as pixelColorAt above — not a hand-rolled webp/PNG parser.
    const pixels = await page.evaluate(async (url) => {
      const res = await fetch(url as string);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      // Sampled a few px in from each edge, not the literal corner pixel
      // — a safety margin against any single-pixel edge antialiasing,
      // while staying far (tens of px) from the fixture's own internal
      // quadrant boundaries (see the comment above on the chosen drag
      // fractions).
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: bitmap.width,
        height: bitmap.height,
        tl: at(3, 3),
        tr: at(bitmap.width - 4, 3),
        bl: at(3, bitmap.height - 4),
        br: at(bitmap.width - 4, bitmap.height - 4),
      };
    }, dataUrl);

    // Dimensions: derived from the FIXTURE's own known natural size and
    // the drag fractions chosen above — never from cropMath.
    const expectedWidth = QUADRANTS.naturalWidth * (1 - dxFraction);
    const expectedHeight = QUADRANTS.naturalHeight * (1 - dyFraction);
    closeBox(pixels.width, expectedWidth, 4);
    closeBox(pixels.height, expectedHeight, 4);

    function closeColor(actual: number[], expected: [number, number, number], label: string) {
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(actual[channel]! - expected[channel]!),
          `${label}: expected rgb(${expected.join(',')}), got rgb(${actual.slice(0, 3).join(',')})`,
        ).toBeLessThanOrEqual(24); // WebP q=0.92 is lossy — see WEBP_OUTPUT_QUALITY's own comment
      }
    }
    closeColor(pixels.tl, [255, 0, 0], 'top-left corner (expected red)');
    closeColor(pixels.tr, [0, 255, 0], 'top-right corner (expected green)');
    closeColor(pixels.bl, [0, 0, 255], 'bottom-left corner (expected blue)');
    closeColor(pixels.br, [255, 255, 0], 'bottom-right corner (expected yellow)');
  });
});

/**
 * PhotoCropEditor.tsx's three rotation branches (90°/180°/270°) are, by
 * shape alone (the bounding-box block above), indistinguishable from their
 * mirror-image bug: swapping the 90° branch's translate/rotate for the
 * 270° branch's would still leave the CSS preview turning clockwise while
 * the SAVED bitmap silently turns the other way, and every width/height-
 * only assertion above is identical either direction — a 90°-CW and a
 * 90°-CCW rotation of a WxH image both produce an HxW canvas. This block
 * pins the actual DIRECTION with real, decoded pixels.
 */
test.describe('PhotoCropEditor — rotation direction is pixel-verified, not just shape-verified', () => {
  test('rotating 90° via "Rotate right" turns the SAVED bitmap the same direction as the on-screen preview (clockwise)', async ({ page }) => {
    await gotoHarness(page, QUADRANTS);
    await rotateTo(page, 90);

    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(page.getByLabel('harness outcome')).toHaveText(/^saved:/);

    const dataUrl = await page.evaluate(
      () => (window as unknown as { __lastSavedDataUrl?: string }).__lastSavedDataUrl,
    );
    expect(dataUrl).toBeTruthy();

    const pixels = await page.evaluate(async (url) => {
      const res = await fetch(url as string);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: bitmap.width,
        height: bitmap.height,
        tl: at(3, 3),
        tr: at(bitmap.width - 4, 3),
        bl: at(3, bitmap.height - 4),
        br: at(bitmap.width - 4, bitmap.height - 4),
      };
    }, dataUrl);

    // QUADRANTS is 400x300 with TL=red, TR=green, BL=blue, BR=yellow.
    // Rotating any rectangle 90° CLOCKWISE about its centre is a fixed
    // corner permutation, independent of anything PhotoCropEditor.tsx
    // itself computes: TL->TR, TR->BR, BR->BL, BL->TL. So the NEW
    // top-left is whatever occupied the OLD bottom-left (blue), new
    // top-right is the old top-left (red), and so on. A 90°
    // COUNTER-clockwise rotation (the bug this guards against) produces
    // the exact opposite permutation — a completely different colour at
    // every corner, not a subtle off-by-one, so this cannot pass by
    // accident either way.
    closeBox(pixels.width, QUADRANTS.naturalHeight, 4);
    closeBox(pixels.height, QUADRANTS.naturalWidth, 4);

    function closeColor(actual: number[], expected: [number, number, number], label: string) {
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(actual[channel]! - expected[channel]!),
          `${label}: expected rgb(${expected.join(',')}), got rgb(${actual.slice(0, 3).join(',')})`,
        ).toBeLessThanOrEqual(24);
      }
    }
    closeColor(pixels.tl, [0, 0, 255], 'top-left after 90° CW (was bottom-left = blue before rotating)');
    closeColor(pixels.tr, [255, 0, 0], 'top-right after 90° CW (was top-left = red before rotating)');
    closeColor(pixels.br, [0, 255, 0], 'bottom-right after 90° CW (was top-right = green before rotating)');
    closeColor(pixels.bl, [255, 255, 0], 'bottom-left after 90° CW (was bottom-right = yellow before rotating)');
  });
});

/**
 * PhotoCropEditor used to build the output canvas at the crop region's
 * full NATURAL resolution regardless of size, then `toBlob` it — a server
 * implementing docs/server-contract.md downsizes to its own cap anyway
 * (2400px on the longest side, in the reference implementation), so every
 * pixel beyond that was encoded, uploaded, decoded and thrown away for
 * nothing. The fix caps the OUTPUT canvas at MAX_OUTPUT_DIMENSION_PX
 * before `toBlob`; both tests below decode the actual saved bitmap
 * (ground truth, not a `drawImage` call-arguments capture, and NOT
 * computed via any function this file imports from the component) and
 * their expected numbers are derived from the fixtures' own known
 * dimensions plus the documented rotation-permutation math already
 * established above, never from `capOutputSize`/`MAX_OUTPUT_DIMENSION_PX`
 * themselves.
 */
test.describe('PhotoCropEditor — output resolution is capped before toBlob', () => {
  test('a >2400px region is downscaled so its longest side is exactly 2400, aspect ratio and quadrant colours preserved', async ({ page }) => {
    await gotoHarness(page, QUADRANTS_OVER_CAP);
    // Rotate 90° so the full-frame region becomes 3600x4800 (see
    // QUADRANTS_OVER_CAP's own comment) — this both triggers `hasChanges`
    // (a plain unrotated full-frame crop is a no-op "Close", never a save
    // — see handleSaveOrClose) AND lands the fixture's exact 2x-cap
    // dimensions without any crop-drag arithmetic in the way.
    await rotateTo(page, 90);

    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(page.getByLabel('harness outcome')).toHaveText(/^saved:/);

    const dataUrl = await page.evaluate(
      () => (window as unknown as { __lastSavedDataUrl?: string }).__lastSavedDataUrl,
    );
    expect(dataUrl).toBeTruthy();

    const pixels = await page.evaluate(async (url) => {
      const res = await fetch(url as string);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: bitmap.width,
        height: bitmap.height,
        tl: at(3, 3),
        tr: at(bitmap.width - 4, 3),
        bl: at(3, bitmap.height - 4),
        br: at(bitmap.width - 4, bitmap.height - 4),
      };
    }, dataUrl);

    // EXACT, not "close to" — 4800x3600 rotated 90° is 3600x4800, and
    // 4800 (the longest side) is exactly 2x the 2400 cap, so the capped
    // output is exactly 1800x2400 with zero rounding.
    expect(pixels.width).toBe(1800);
    expect(pixels.height).toBe(2400);

    function closeColor(actual: number[], expected: [number, number, number], label: string) {
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(actual[channel]! - expected[channel]!),
          `${label}: expected rgb(${expected.join(',')}), got rgb(${actual.slice(0, 3).join(',')})`,
        ).toBeLessThanOrEqual(24); // WebP q=0.92 is lossy — see WEBP_OUTPUT_QUALITY's own comment
      }
    }
    // QUADRANTS_OVER_CAP is TL=red, TR=green, BL=blue, BR=yellow before
    // rotating — same 90° CW corner permutation as the block above (new
    // TL <- old BL, new TR <- old TL, new BR <- old TR, new BL <- old BR),
    // so a scale-only bug that shifted or mirrored the region (rather than
    // just resizing it) would land the wrong colour in at least one corner.
    closeColor(pixels.tl, [0, 0, 255], 'top-left after 90° CW (was bottom-left = blue before rotating)');
    closeColor(pixels.tr, [255, 0, 0], 'top-right after 90° CW (was top-left = red before rotating)');
    closeColor(pixels.br, [0, 255, 0], 'bottom-right after 90° CW (was top-right = green before rotating)');
    closeColor(pixels.bl, [255, 255, 0], 'bottom-left after 90° CW (was bottom-right = yellow before rotating)');
  });

  test('a source under the cap on both sides is saved at its exact natural size — no upscale, byte-identical dimensions', async ({ page }) => {
    await gotoHarness(page, QUADRANTS);
    // 180° rotation preserves width/height exactly (rotatedDimensions is a
    // no-op swap-wise at 180°) while still setting `hasChanges` so an
    // actual save/encode happens — a plain unrotated full-frame crop is a
    // no-op "Close" and never reaches toBlob at all.
    await rotateTo(page, 180);

    await page.getByRole('button', { name: 'Save edit' }).click();
    await expect(page.getByLabel('harness outcome')).toHaveText(/^saved:/);

    const dataUrl = await page.evaluate(
      () => (window as unknown as { __lastSavedDataUrl?: string }).__lastSavedDataUrl,
    );
    expect(dataUrl).toBeTruthy();

    const pixels = await page.evaluate(async (url) => {
      const res = await fetch(url as string);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: bitmap.width,
        height: bitmap.height,
        tl: at(3, 3),
        tr: at(bitmap.width - 4, 3),
        bl: at(3, bitmap.height - 4),
        br: at(bitmap.width - 4, bitmap.height - 4),
      };
    }, dataUrl);

    // QUADRANTS is 400x300, well under the 2400 cap on both sides — must
    // come out at EXACTLY its natural size, not merely "close to" it.
    expect(pixels.width).toBe(400);
    expect(pixels.height).toBe(300);

    function closeColor(actual: number[], expected: [number, number, number], label: string) {
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(actual[channel]! - expected[channel]!),
          `${label}: expected rgb(${expected.join(',')}), got rgb(${actual.slice(0, 3).join(',')})`,
        ).toBeLessThanOrEqual(24);
      }
    }
    // 180° about the centre maps old TL<->new BR and old TR<->new BL (a
    // fixed permutation, independent of this component's own code — same
    // reasoning as the 90° case above, just the other rotation amount).
    closeColor(pixels.tl, [255, 255, 0], 'top-left after 180° (was bottom-right = yellow before rotating)');
    closeColor(pixels.tr, [0, 0, 255], 'top-right after 180° (was bottom-left = blue before rotating)');
    closeColor(pixels.bl, [0, 255, 0], 'bottom-left after 180° (was top-right = green before rotating)');
    closeColor(pixels.br, [255, 0, 0], 'bottom-right after 180° (was top-left = red before rotating)');
  });
});

test.describe('PhotoCropEditor — responsive stage on a phone viewport', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('a 4000x3000 source fits entirely within the 390px viewport, no unreachable region', async ({ page }) => {
    await gotoHarness(page, WIDE_SOURCE);

    const stage = page.locator('[class*="_stage_"]');
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();

    // The whole stage — and therefore every crop handle — must be within
    // the viewport's width. Without a viewport-aware cap, the fixed
    // MAX_STAGE_WIDTH=640 hard cap alone left a large fraction of this
    // exact source unreachable on a real phone screen.
    expect(stageBox!.x).toBeGreaterThanOrEqual(0);
    expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(390);

    // And the image itself still exactly fills the (now-responsive) stage.
    const img = page.locator('img[alt=""]');
    const imgBox = await img.boundingBox();
    expect(imgBox).not.toBeNull();
    closeBox(imgBox!.width, stageBox!.width);
    closeBox(imgBox!.height, stageBox!.height);
  });

  test('the crop dialog itself causes no horizontal page overflow at 390px', async ({ page }) => {
    await gotoHarness(page, WIDE_SOURCE);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // +1: sub-pixel rounding tolerance
  });
});

/**
 * The dimming shadow lives on a SEPARATE clipped layer from the crop rect
 * (.dimClip/.dimRect vs .cropRect, in PhotoCropEditor.module.css) rather
 * than as a box-shadow directly on .cropRect — because .cropRect must stay
 * UNclipped for its corner handles to remain hit-testable half outside the
 * stage at the default full-frame crop, but that also means a box-shadow
 * painted directly on it would be unclipped too, flooding the whole
 * dialog at 45% black instead of just dimming the photo outside the crop
 * rectangle. Both halves of that split have to be proven together: that
 * the dimming stays CONFINED to the stage (below), and that it still
 * actually HAPPENS (the second test) — a fix that satisfies only one half
 * (e.g. deleting the box-shadow outright "fixes" the leak by removing the
 * feature) would pass a one-sided assertion.
 */
test.describe('PhotoCropEditor — dimming is confined to the stage, not the whole dialog', () => {
  test("a point in the dialog just above the stage is the dialog's own background, not the dimming overlay", async ({ page }) => {
    await gotoHarness(page, SQUARE);
    const stage = page.locator('[class*="_stage_"]');
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();

    // A point inside .dialog's own padding, a few px above the stage's
    // top edge — exactly where a leaking dimming layer would paint 45%
    // black instead of the dialog's background.
    const x = stageBox!.x + stageBox!.width / 2;
    const y = Math.max(0, stageBox!.y - 8);
    const { r, g, b } = await pixelColorAt(page, x, y);
    // Undimmed default surface: rgb(255,255,255). At 45% dimming:
    // rgb(140,140,140) (255 * 0.55 = 140.25). A tolerance of 20
    // comfortably separates the two without being screenshot-exact.
    expect(r, `expected an undimmed light pixel above the stage, got rgb(${r},${g},${b})`).toBeGreaterThan(230);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(230);
  });

  /**
   * The POSITIVE half of the same property, and the reason this test
   * exists: the assertion above only proves the dimming does not LEAK.
   * Deleting `.dimRect`'s `box-shadow` outright — i.e. removing the
   * dimming feature altogether — would leave that test green too, because
   * nothing there asserts the dimming still happens. Both halves have to
   * hold.
   */
  test('the photo outside the crop rectangle IS actually dimmed once the crop is shrunk', async ({ page }) => {
    await gotoHarness(page, SQUARE);
    const stage = page.locator('[class*="_stage_"]');
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();

    // Sample a point near the stage's bottom-right, which is inside the
    // photo at the default full-frame crop and outside it afterwards.
    const sampleX = stageBox!.x + stageBox!.width * 0.9;
    const sampleY = stageBox!.y + stageBox!.height * 0.9;

    const before = await pixelColorAt(page, sampleX, sampleY);

    // Shrink the crop by dragging the "se" handle inward, well past the
    // sample point (30% of each dimension, vs the sample's 10% inset).
    const handle = page.locator('[class*="handle-se"]');
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - stageBox!.width * 0.3, startY - stageBox!.height * 0.3, { steps: 8 });
    await page.mouse.up();

    const after = await pixelColorAt(page, sampleX, sampleY);

    // 45% black over the same pixel: each channel drops to 55% of itself.
    // Asserting the RATIO rather than a fixed colour keeps this
    // independent of which quadrant the sample point lands in.
    const brightestBefore = Math.max(before.r, before.g, before.b);
    const brightestAfter = Math.max(after.r, after.g, after.b);
    expect(
      brightestBefore,
      `sample point must be light enough for a 45% drop to be measurable, got rgb(${before.r},${before.g},${before.b})`,
    ).toBeGreaterThan(60);
    expect(
      brightestAfter,
      `after shrinking the crop, the point outside it should be dimmed to ~55%, got rgb(${after.r},${after.g},${after.b}) from rgb(${before.r},${before.g},${before.b})`,
    ).toBeLessThan(brightestBefore * 0.75);
  });
});

test.describe('PhotoCropEditor — corner handles stay hit-testable after the dimming split', () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 800 },
  ]) {
    test.describe(`at ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });
      for (const rotation of ROTATIONS) {
        test(`all four corner handles are hit by elementFromPoint at their centres, ${rotation}°`, async ({ page }) => {
          await gotoHarness(page, LANDSCAPE);
          await rotateTo(page, rotation);

          for (const corner of ['nw', 'ne', 'se', 'sw'] as const) {
            const handle = page.locator(`[class*="handle-${corner}"]`);
            const box = await handle.boundingBox();
            expect(box, `${corner} handle has no box`).not.toBeNull();
            const x = box!.x + box!.width / 2;
            const y = box!.y + box!.height / 2;
            const hitsHandle = await page.evaluate(
              ({ x, y, corner }) => {
                const el = document.elementFromPoint(x, y);
                return !!el && Array.from(el.classList).some((cls) => cls.includes(`handle-${corner}`));
              },
              { x, y, corner },
            );
            expect(hitsHandle, `${corner} handle centre (${x}, ${y}) was not hit by elementFromPoint`).toBe(true);
          }
        });
      }
    });
  }
});
