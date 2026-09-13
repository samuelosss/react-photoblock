import { expect, test } from '@playwright/test';

/**
 * PhotoUploader.tsx's `pendingFocusRef` comment claims a real-Chromium-only
 * finding: relocating a keyboard-moved tile's DOM node (React's
 * `key={url}` reconciliation) does NOT by itself blur a focused button;
 * what actually blurs it is Chromium auto-blurring an element the instant
 * it becomes `disabled` (which only the move that lands a photo at an END
 * position triggers). Nothing in JSDOM can observe either half of that
 * claim (confirmed separately: disabling a focused JSDOM button via React
 * leaves `document.activeElement` unchanged, unlike a real browser), so
 * this is the standing Playwright regression for it — see
 * e2e/harness/src/PhotoUploaderHarness.tsx's own doc.
 *
 * Drives a real sequence of four rightward keyboard-style moves (mouse
 * click, which also focuses the button first, exactly like a keyboard
 * Enter/Space press) through all five photos, checking after EACH move
 * that focus landed exactly where PhotoUploader's own refocus effect
 * intends — including the 4th move, the one that actually disables the
 * just-used button and is where the real bug this guards against would
 * first show up as focus falling to <body>.
 */
test.describe('PhotoUploader — focus survives a full keyboard reorder sequence, including the disabling move', () => {
  test('four consecutive rightward moves never leave focus on <body>, including the 4th (disabling) move', async ({ page }) => {
    await page.goto('/photo-uploader.html');
    await expect(page.getByRole('button', { name: 'Move photo 1 of 5 right' })).toBeVisible();

    const expectedFocusAfterEachMove = [
      'Move photo 2 of 5 right',
      'Move photo 3 of 5 right',
      'Move photo 4 of 5 right',
      // The 4th move lands the photo at the LAST position — "right" is
      // now disabled there, so the refocus effect falls back to the
      // opposite direction (see pendingFocusRef's own comment). This is
      // the exact step where a missing/broken refocus would blur to
      // <body> in a real browser.
      'Move photo 5 of 5 left',
    ];

    let currentLabel = 'Move photo 1 of 5 right';
    for (const expectedLabel of expectedFocusAfterEachMove) {
      // eslint-disable-next-line no-await-in-loop
      await page.getByRole('button', { name: currentLabel }).click();
      // eslint-disable-next-line no-await-in-loop
      const activeLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      expect(activeLabel, `expected focus on "${expectedLabel}" after clicking "${currentLabel}"`).toBe(expectedLabel);
      // eslint-disable-next-line no-await-in-loop
      const focusFellToBody = await page.evaluate(() => document.activeElement === document.body);
      expect(focusFellToBody, 'focus fell back to <body> — the real-Chromium blur this test exists to catch').toBe(
        false,
      );
      currentLabel = expectedLabel;
    }
  });
});
