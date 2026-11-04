import { test, expect } from '@playwright/test';

test('basic example renders MediaUploader with zero CSS/Google config, and a picked file queues locally', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'react-mediablock — basic example' })).toBeVisible();
  // The dropzone renders with the package's own default English label and
  // its own built-in styling (no app-level CSS setup beyond the imported
  // stylesheet) — a dashed border is one of its --mblock-border fallback
  // values, checked via a real computed style, not just text presence.
  const dropzone = page.getByText('+ Add photos, or drag them here');
  await expect(dropzone).toBeVisible();
  const borderStyle = await dropzone.evaluate((el) => getComputedStyle(el).borderStyle);
  expect(borderStyle).toBe('dashed');

  // No Google Photos button — the example passes no `googlePhotos` prop.
  await expect(page.getByRole('button', { name: /google photos/i })).toHaveCount(0);

  // The example wires up video too, so there are two dropzones — and the
  // video one must be the SECOND, after the photo controls. In the origin
  // project the Google Photos button sat under the video hint and was
  // reasonably read as the video picker.
  await expect(page.getByText('+ Add a video, or drag it here')).toBeVisible();

  // Pick a photo via its own hidden input and confirm it lands (entityId is
  // set from mount, so it uploads through the fake backend and appears as a
  // real photo tile).
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await expect(page.getByRole('button', { name: /delete photo/i })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-media-kind="photo"]')).toHaveCount(1);
});

test('a picked video is queued while "transcoding", then becomes a grid tile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('+ Add a video, or drag it here')).toBeVisible();

  await page
    .locator('input[type="file"][accept^="video/"]')
    .setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0, 0, 0, 24]) });

  // While it is 'processing' it has no poster, so it is NOT a grid tile —
  // it belongs in the queue panel. A blank square would not be an
  // improvement.
  await expect(page.getByText('Processing…')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-media-kind="video"]')).toHaveCount(0);

  // The fake transcode takes ~3s, after which the poll picks it up.
  await expect(page.locator('[data-media-kind="video"]')).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByRole('button', { name: /delete video/i })).toBeVisible();
});
