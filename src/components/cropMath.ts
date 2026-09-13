/**
 * Pure geometry for PhotoCropEditor — deliberately kept free of any DOM/
 * canvas/React dependency so it can be unit-tested directly (JSDOM has no
 * layout engine and no real <canvas> renderer, so this is the part of the
 * crop editor that CAN be meaningfully tested in JSDOM). All coordinates
 * are FRACTIONS (0..1) of the displayed (already rotated) image box,
 * independent of actual on-screen pixel size, so the same math works
 * regardless of how large the editor renders.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: a fraction of the crop rect
 * MUST equal the same fraction of the actual image. That only holds if
 * whatever pixel box the fractions are measured against (the "stage", in
 * PhotoCropEditor.tsx) has EXACTLY the image's own aspect ratio — any
 * letterboxing (a stage wider/taller than the image, with the image
 * shrunk to fit inside it) breaks the equivalence, because a fraction of
 * the (bigger) stage no longer lands on the same point as that fraction
 * of the (smaller) image. `containBox` below is what makes the STAGE
 * match the image exactly, with zero letterbox gap, instead of patching
 * the arithmetic after the fact — but this file only computes the sizes
 * and fractions; PhotoCropEditor.tsx still has to render an `<img>` at
 * EXACTLY the size this returns, with nothing (e.g. an inherited CSS
 * `max-width`) silently clamping it back down. See PhotoCropEditor.tsx's
 * MAX_STAGE_WIDTH comment and PhotoCropEditor.module.css's `.image` rule
 * for a real regression of exactly that kind — this file's own
 * correctness was never in question there, only whether the DOM actually
 * honored it.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw';

/** The default crop — the whole image, uncropped, until the user drags something. */
export const FULL_CROP_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** Smallest allowed crop box, as a fraction of the display box on each axis — prevents dragging a handle down to a zero/negative-size rect. */
const MIN_CROP_FRACTION = 0.05;

const ROTATION_STEPS: Rotation[] = [0, 90, 180, 270];

/** Cycles rotation by one 90° step in either direction, wrapping around. */
export function nextRotation(current: Rotation, direction: 1 | -1): Rotation {
  const idx = ROTATION_STEPS.indexOf(current);
  const nextIdx = (idx + direction + ROTATION_STEPS.length) % ROTATION_STEPS.length;
  return ROTATION_STEPS[nextIdx]!;
}

/** Width/height swap at 90°/270° — a sideways image displays and crops in swapped dimensions. */
export function rotatedDimensions(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

export interface Box {
  width: number;
  height: number;
}

/**
 * Computes a box with EXACTLY `contentWidth x contentHeight`'s aspect
 * ratio, as large as possible within `maxWidth x maxHeight` — the same
 * shape as CSS `object-fit: contain`, but computed for the CONTAINER
 * (the "stage") rather than for an `<img>` inside a fixed-size container.
 * This is the fix for the class of bug where a crop rectangle positioned
 * in percentages of a letterboxed stage does not line up with the same
 * percentage of the image: if the stage IS this box, the image fills it
 * with zero letterbox gap, so stage fractions and image fractions are
 * the same fractions.
 */
export function containBox(contentWidth: number, contentHeight: number, maxWidth: number, maxHeight: number): Box {
  if (contentWidth <= 0 || contentHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const contentRatio = contentWidth / contentHeight;
  const maxRatio = maxWidth / maxHeight;
  if (contentRatio > maxRatio) {
    // Content is relatively WIDER than the box — width is the binding constraint.
    return { width: maxWidth, height: maxWidth / contentRatio };
  }
  // Content is relatively TALLER than (or equal to) the box — height binds.
  return { width: maxHeight * contentRatio, height: maxHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keeps a crop rect fully inside [0,1] on both axes and at least MIN_CROP_FRACTION in size. */
export function clampCropRect(rect: CropRect): CropRect {
  const width = clamp(rect.width, MIN_CROP_FRACTION, 1);
  const height = clamp(rect.height, MIN_CROP_FRACTION, 1);
  const x = clamp(rect.x, 0, 1 - width);
  const y = clamp(rect.y, 0, 1 - height);
  return { x, y, width, height };
}

/** Translates the whole rect by (dx, dy), clamped so it never leaves the [0,1] box. */
export function moveCropRect(rect: CropRect, dx: number, dy: number): CropRect {
  return clampCropRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/**
 * Drags ONE corner of the rect by (dx, dy), keeping the OPPOSITE corner
 * fixed. Each of the four edges (left/top/right/bottom) is clamped
 * INDEPENDENTLY: to the [0,1] screen bounds, AND to the fixed opposite
 * edge ± MIN_CROP_FRACTION — so the moving edge can never cross the
 * anchor (no silent "flip" past the pivot) and the anchor edge itself
 * never moves, regardless of how large a delta is passed in.
 */
export function resizeCropRect(rect: CropRect, corner: Corner, dx: number, dy: number): CropRect {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  let newLeft = left;
  let newRight = right;
  if (corner === 'nw' || corner === 'sw') {
    newLeft = clamp(left + dx, 0, right - MIN_CROP_FRACTION); // anchor: right edge
  } else {
    newRight = clamp(right + dx, left + MIN_CROP_FRACTION, 1); // anchor: left edge
  }

  let newTop = top;
  let newBottom = bottom;
  if (corner === 'nw' || corner === 'ne') {
    newTop = clamp(top + dy, 0, bottom - MIN_CROP_FRACTION); // anchor: bottom edge
  } else {
    newBottom = clamp(bottom + dy, top + MIN_CROP_FRACTION, 1); // anchor: top edge
  }

  return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
}

export interface CropPixelRegion {
  /** Size of the FULL (rotated) image in pixels — the intermediate canvas this region is cut from. */
  rotatedWidth: number;
  rotatedHeight: number;
  /** The crop region itself, in that same rotated-pixel space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a fractional crop rect (against the ROTATED display box) into
 * whole-pixel coordinates in that same rotated image's pixel space, given
 * the ORIGINAL (unrotated) natural image dimensions.
 *
 * width/height are derived from the RIGHT/BOTTOM edge fractions (rounded
 * independently), not from `x + round(width fraction * size)` — rounding
 * `x` and `width` separately can overshoot the source canvas by a pixel
 * on odd dimensions (e.g. x=1201 + width=1201 against a 2401px-wide
 * canvas). Deriving width as `round(rightFraction * size) - x` guarantees
 * `x + width` never exceeds `rotatedWidth`/`rotatedHeight`.
 */
export function computeCropPixelRegion(
  naturalWidth: number,
  naturalHeight: number,
  rotation: Rotation,
  crop: CropRect,
): CropPixelRegion {
  const { width: rotatedWidth, height: rotatedHeight } = rotatedDimensions(naturalWidth, naturalHeight, rotation);
  const x = Math.round(crop.x * rotatedWidth);
  const y = Math.round(crop.y * rotatedHeight);
  const right = Math.min(rotatedWidth, Math.round((crop.x + crop.width) * rotatedWidth));
  const bottom = Math.min(rotatedHeight, Math.round((crop.y + crop.height) * rotatedHeight));
  return {
    rotatedWidth,
    rotatedHeight,
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
