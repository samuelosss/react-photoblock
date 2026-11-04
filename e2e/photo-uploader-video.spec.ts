import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The video half of the authoring grid, in a real browser.
 *
 * Everything here is a claim JSDOM structurally cannot make: a measured
 * box, a painted x-coordinate, or a layout rule. The state-machine half
 * (what gets uploaded, what reaches which callback, what `media` carries)
 * is covered by the JSDOM suite instead — see
 * test/PhotoUploader.video.test.tsx and
 * test/PhotoUploader.mediaSync.test.tsx.
 */

/** The grid's painted left-to-right order, read from x-coordinates rather
 *  than document order — see the harness's own doc for why those are not
 *  the same claim. */
async function paintedOrder(page: Page): Promise<string[]> {
  const tiles = await page.locator('[data-media-kind]').all();
  const measured = await Promise.all(
    tiles.map(async (tile) => {
      const box = await tile.boundingBox();
      return {
        key: `${await tile.getAttribute('data-media-kind')}:${await tile.getAttribute('data-media-id')}`,
        x: box?.x ?? 0,
        y: box?.y ?? 0,
      };
    }),
  );
  return measured.sort((a, b) => a.y - b.y || a.x - b.x).map((item) => item.key);
}

test.describe('PhotoUploader — a video in the combined grid', () => {
  test('a READY video paints BETWEEN the two photos, which `imageUrls` alone cannot express', async ({ page }) => {
    await page.goto('/video-uploader.html');
    await expect(page.locator('[data-media-kind="video"][data-media-id="5"]')).toBeVisible();

    expect(await paintedOrder(page)).toEqual(['photo:10', 'video:5', 'photo:20']);
  });

  test('its poster actually decodes — a tile with no pixels is the bug this replaced', async ({ page }) => {
    await page.goto('/video-uploader.html');
    const poster = page.locator('[data-media-kind="video"] img');
    await expect(poster).toBeVisible();

    // naturalWidth > 0 is true only once real pixels decoded. A 404, a
    // 401 or an omitted src all leave it at 0 while the element still
    // looks present in the DOM.
    await expect
      .poll(async () => poster.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test('a keyboard move on the VIDEO tile actually repaints it in its new position', async ({ page }) => {
    await page.goto('/video-uploader.html');
    await expect(page.locator('[data-media-id="5"]')).toBeVisible();
    expect(await paintedOrder(page)).toEqual(['photo:10', 'video:5', 'photo:20']);

    await page.getByRole('button', { name: 'Move video 2 of 3 left' }).click();

    // The origin project's bug: the handler fired and the server stored
    // the new order, but the response re-derived photos-then-videos and
    // the tile snapped straight back.
    await expect.poll(() => paintedOrder(page)).toEqual(['video:5', 'photo:10', 'photo:20']);
  });

  /**
   * A 'processing' video has no poster, so a tile for it would be a blank
   * square. JSDOM can see the absence of the element; only a real browser
   * can confirm the queue row it goes to instead is actually painted and
   * not, say, zero-height.
   */
  test('a PROCESSING video is not a tile at all, and its queue row is really visible', async ({ page }) => {
    await page.goto('/video-uploader.html?processing=1');
    await expect(page.locator('[data-media-kind="video"][data-media-id="5"]')).toBeVisible();

    await expect(page.locator('[data-media-kind="video"][data-media-id="6"]')).toHaveCount(0);
    const queueRow = page.locator('[data-video-id="6"]');
    await expect(queueRow).toBeVisible();
    const box = await queueRow.boundingBox();
    expect(box!.height).toBeGreaterThan(10);
  });
});

/**
 * THE PROPORTION IS THE THING, not the pixel count.
 *
 * The origin project's first attempt scaled the disc the WRONG WAY ROUND:
 * `clamp(38px, 26%, 88px)` put the FLOOR in a small cell (the badge
 * swallowed it) and the CEILING on a large one (the badge vanished), so
 * the share of the tile ranged over roughly 8%-48% while every absolute
 * pixel value looked plausible. A test pinned to pixels cannot see that
 * inversion — so these measure the RATIO, and compare two very different
 * tile sizes against each other.
 */
test.describe('PhotoUploader — the play affordance is a constant share of its tile', () => {
  /** disc width as a fraction of the tile's SHORT side. */
  async function discShare(page: Page, tilePx: number): Promise<number> {
    await page.goto(`/video-uploader.html?tile=${tilePx}`);
    const tile = page.locator('[data-media-kind="video"] [class*="photo"]').first();
    await expect(tile).toBeVisible();
    const badge = page.locator('[data-media-kind="video"] svg').first();
    await expect(badge).toBeVisible();

    const tileBox = (await tile.boundingBox())!;
    const badgeBox = (await badge.boundingBox())!;
    // A disc is a circle, so it has to fit the SHORT side. That is the
    // whole reason the CSS sizes from `cqmin` rather than a width
    // percentage.
    const shortSide = Math.min(tileBox.width, tileBox.height);
    expect(badgeBox.width).toBeLessThanOrEqual(shortSide);
    return badgeBox.width / shortSide;
  }

  // Both sizes sit inside the band where the SHARE decides, rather than
  // the clamp's legibility floor (below ~83px) or its wide-container
  // backstop (above ~583px). That is deliberate: a size where a bound
  // binds would mask exactly the inversion these tests exist to catch.
  const SMALL_TILE_PX = 120;
  const LARGE_TILE_PX = 500;

  test(`holds the intended share in a small (${SMALL_TILE_PX}px) tile`, async ({ page }) => {
    expect(await discShare(page, SMALL_TILE_PX)).toBeCloseTo(0.24, 2);
  });

  test(`holds the SAME share in a large (${LARGE_TILE_PX}px) tile`, async ({ page }) => {
    expect(await discShare(page, LARGE_TILE_PX)).toBeCloseTo(0.24, 2);
  });

  test('the two shares are equal to each other — the assertion an INVERSION fails', async ({ page }) => {
    const small = await discShare(page, SMALL_TILE_PX);
    const large = await discShare(page, LARGE_TILE_PX);

    // The inverted `clamp(38px, 24%, 88px)` version gives ~0.317 here and
    // ~0.176 there: this assertion is what tells them apart, and pinned
    // pixel values would not.
    expect(Math.abs(small - large)).toBeLessThan(0.02);
  });
});
