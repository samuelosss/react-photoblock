import { describe, expect, it } from 'vitest';
import {
  clampCropRect,
  computeCropPixelRegion,
  containBox,
  FULL_CROP_RECT,
  moveCropRect,
  nextRotation,
  resizeCropRect,
  rotatedDimensions,
} from '../src/components/cropMath';

describe('nextRotation', () => {
  it('steps forward through 0 -> 90 -> 180 -> 270 -> 0', () => {
    expect(nextRotation(0, 1)).toBe(90);
    expect(nextRotation(90, 1)).toBe(180);
    expect(nextRotation(180, 1)).toBe(270);
    expect(nextRotation(270, 1)).toBe(0);
  });

  it('steps backward through 0 -> 270 -> 180 -> 90 -> 0', () => {
    expect(nextRotation(0, -1)).toBe(270);
    expect(nextRotation(270, -1)).toBe(180);
    expect(nextRotation(180, -1)).toBe(90);
    expect(nextRotation(90, -1)).toBe(0);
  });
});

describe('rotatedDimensions', () => {
  it('keeps width/height unchanged at 0° and 180°', () => {
    expect(rotatedDimensions(800, 600, 0)).toEqual({ width: 800, height: 600 });
    expect(rotatedDimensions(800, 600, 180)).toEqual({ width: 800, height: 600 });
  });

  it('swaps width/height at 90° and 270° (a sideways image)', () => {
    expect(rotatedDimensions(800, 600, 90)).toEqual({ width: 600, height: 800 });
    expect(rotatedDimensions(800, 600, 270)).toEqual({ width: 600, height: 800 });
  });
});

describe('clampCropRect', () => {
  it('leaves an already-valid rect unchanged', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
    expect(clampCropRect(rect)).toEqual(rect);
  });

  it('pulls x/y back so the rect never crosses the right/bottom edge', () => {
    expect(clampCropRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  });

  it('clamps a negative x/y to 0', () => {
    expect(clampCropRect({ x: -0.3, y: -0.2, width: 0.4, height: 0.4 })).toEqual({ x: 0, y: 0, width: 0.4, height: 0.4 });
  });

  it('enforces a minimum size instead of collapsing to zero', () => {
    const result = clampCropRect({ x: 0.5, y: 0.5, width: 0, height: -0.1 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('never exceeds the full [0,1] box even when width/height is 1', () => {
    const result = clampCropRect({ x: 0.5, y: 0.5, width: 1, height: 1 });
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});

describe('moveCropRect', () => {
  it('translates the rect by the given delta', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
    const moved = moveCropRect(rect, 0.1, 0.05);
    expect(moved.x).toBeCloseTo(0.3);
    expect(moved.y).toBeCloseTo(0.25);
    expect(moved.width).toBe(0.3);
    expect(moved.height).toBe(0.3);
  });

  it('stops at the edge instead of moving the rect outside the box', () => {
    const rect = { x: 0.8, y: 0.8, width: 0.3, height: 0.3 };
    const moved = moveCropRect(rect, 0.5, 0.5);
    expect(moved.x + moved.width).toBeLessThanOrEqual(1.0001);
    expect(moved.y + moved.height).toBeLessThanOrEqual(1.0001);
  });

  it('does not change the rect size, only its position', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.4 };
    const moved = moveCropRect(rect, 0.1, 0.1);
    expect(moved.width).toBe(0.3);
    expect(moved.height).toBe(0.4);
  });
});

describe('resizeCropRect', () => {
  it('dragging the "se" (bottom-right) corner outward only grows width/height, keeping x/y fixed', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
    const resized = resizeCropRect(rect, 'se', 0.1, 0.1);
    expect(resized.x).toBe(0.2);
    expect(resized.y).toBe(0.2);
    expect(resized.width).toBeCloseTo(0.4);
    expect(resized.height).toBeCloseTo(0.4);
  });

  it('dragging the "nw" (top-left) corner keeps the OPPOSITE (bottom-right) point fixed', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
    const bottomRightBefore = { x: rect.x + rect.width, y: rect.y + rect.height };

    const resized = resizeCropRect(rect, 'nw', 0.05, 0.05);
    const bottomRightAfter = { x: resized.x + resized.width, y: resized.y + resized.height };

    expect(bottomRightAfter.x).toBeCloseTo(bottomRightBefore.x);
    expect(bottomRightAfter.y).toBeCloseTo(bottomRightBefore.y);
    // The box actually got smaller (dragged inward), not just relabeled.
    expect(resized.width).toBeLessThan(rect.width);
  });

  it('dragging a corner past the opposite edge stops at the minimum size WITHOUT the anchor edge moving (no flip past the pivot)', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.3 };
    // Reviewer-reported regression: dragging 'nw' by +0.6 on this exact
    // rect used to yield {x:0.7, w:0.05} — past the anchor at x=0.6,
    // meaning the "anchored" right edge had actually moved.
    const resized = resizeCropRect(rect, 'nw', 0.6, 0);
    const anchorRight = rect.x + rect.width; // 0.6 — must NOT move
    expect(resized.x + resized.width).toBeCloseTo(anchorRight);
    expect(resized.x).toBeLessThanOrEqual(anchorRight);
    expect(resized.width).toBeCloseTo(0.05); // clamped to MIN, not negative/flipped
  });

  it('an absurdly large drag in any direction still leaves a valid, non-degenerate rect', () => {
    const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
    const resized = resizeCropRect(rect, 'nw', 10, 10);
    expect(resized.width).toBeGreaterThan(0);
    expect(resized.height).toBeGreaterThan(0);
    expect(resized.x).toBeGreaterThanOrEqual(0);
    expect(resized.y).toBeGreaterThanOrEqual(0);
  });
});

describe('containBox — sizes the crop stage to the image\'s OWN aspect ratio (the letterbox-mismatch fix)', () => {
  it('a portrait image is height-constrained inside a landscape max box', () => {
    // The reviewer's exact reported case: 1800x2400 portrait.
    const box = containBox(1800, 2400, 640, 480);
    expect(box.height).toBe(480);
    expect(box.width).toBeCloseTo(360); // 480 * (1800/2400)
    expect(box.width / box.height).toBeCloseTo(1800 / 2400);
  });

  it('a landscape image is width-constrained inside a landscape max box', () => {
    const box = containBox(2400, 1800, 640, 480);
    expect(box.width).toBe(640);
    expect(box.height).toBeCloseTo(480); // 640 * (1800/2400)
    expect(box.width / box.height).toBeCloseTo(2400 / 1800);
  });

  it('a square image fits exactly, matching whichever side of the max box is smaller', () => {
    const box = containBox(1000, 1000, 640, 480);
    expect(box.width).toBe(480);
    expect(box.height).toBe(480);
  });

  it('a 16:9 image fits its own ratio inside a 4:3-ish max box', () => {
    const box = containBox(1920, 1080, 640, 480);
    expect(box.width / box.height).toBeCloseTo(1920 / 1080);
    expect(box.width).toBeLessThanOrEqual(640);
    expect(box.height).toBeLessThanOrEqual(480);
  });

  it('THE INVARIANT: the box returned always has exactly the content\'s aspect ratio, never the max box\'s', () => {
    for (const [w, h] of [[1800, 2400], [2400, 1800], [1000, 1000], [1920, 1080], [3000, 200]]) {
      const box = containBox(w!, h!, 640, 480);
      expect(box.width / box.height).toBeCloseTo(w! / h!, 5);
    }
  });
});

describe('computeCropPixelRegion', () => {
  it('the full-frame crop (no cropping) covers the entire rotated image', () => {
    const region = computeCropPixelRegion(1200, 800, 0, FULL_CROP_RECT);
    expect(region).toEqual({ rotatedWidth: 1200, rotatedHeight: 800, x: 0, y: 0, width: 1200, height: 800 });
  });

  it('converts a fractional crop into whole pixels at 0°', () => {
    const region = computeCropPixelRegion(1000, 500, 0, { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
    expect(region).toEqual({ rotatedWidth: 1000, rotatedHeight: 500, x: 100, y: 100, width: 500, height: 200 });
  });

  it('uses the ROTATED (swapped) dimensions as the crop reference at 90°', () => {
    // A 1000x500 landscape photo rotated 90° displays as 500x1000 —
    // cropping "the left half of the displayed image" must be measured
    // against that 500-wide rotated box, not the original 1000-wide one.
    const region = computeCropPixelRegion(1000, 500, 90, { x: 0, y: 0, width: 0.5, height: 1 });
    expect(region).toEqual({ rotatedWidth: 500, rotatedHeight: 1000, x: 0, y: 0, width: 250, height: 1000 });
  });

  it('never produces a zero-width or zero-height region', () => {
    const region = computeCropPixelRegion(1000, 500, 0, { x: 0.999, y: 0.999, width: 0.0001, height: 0.0001 });
    expect(region.width).toBeGreaterThanOrEqual(1);
    expect(region.height).toBeGreaterThanOrEqual(1);
  });

  it('never overflows the source canvas by rounding x and width independently (odd-dimension regression)', () => {
    // Reviewer-reported: naturalWidth 2401 (odd), crop starting at the
    // midpoint — rounding x and width SEPARATELY used to yield
    // x=1201 + width=1201 = 2402, one pixel past the 2401px-wide source,
    // which drawImage would either error on or pad with a black edge.
    const region = computeCropPixelRegion(2401, 2401, 0, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(region.x + region.width).toBeLessThanOrEqual(region.rotatedWidth);
    expect(region.y + region.height).toBeLessThanOrEqual(region.rotatedHeight);
  });

  it('a full-frame crop on an odd-dimension image covers it exactly, no off-by-one', () => {
    const region = computeCropPixelRegion(2401, 1601, 0, FULL_CROP_RECT);
    expect(region).toEqual({ rotatedWidth: 2401, rotatedHeight: 1601, x: 0, y: 0, width: 2401, height: 1601 });
  });
});
