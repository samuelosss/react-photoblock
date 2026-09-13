import { test, expect } from '@playwright/test';

test('basic example renders PhotoUploader with zero CSS/Google config, and a picked file queues locally', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'react-photoblock — basic example' })).toBeVisible();
  // The dropzone renders with the package's own default English label and
  // its own built-in styling (no app-level CSS setup beyond the imported
  // stylesheet) — a dashed border is one of its --pb-border fallback
  // values, checked via a real computed style, not just text presence.
  const dropzone = page.getByText('+ Add photos, or drag them here');
  await expect(dropzone).toBeVisible();
  const borderStyle = await dropzone.evaluate((el) => getComputedStyle(el).borderStyle);
  expect(borderStyle).toBe('dashed');

  // No Google Photos button — the example passes no `googlePhotos` prop.
  await expect(page.getByRole('button', { name: /google photos/i })).toHaveCount(0);

  // Pick a file via the hidden input and confirm it queues (entityId is
  // set from mount, so it uploads through the fake API and appears as a
  // real photo tile).
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await expect(page.getByRole('button', { name: /delete photo/i })).toBeVisible({ timeout: 5000 });
});
