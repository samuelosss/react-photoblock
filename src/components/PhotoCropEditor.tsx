import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  computeCropPixelRegion,
  containBox,
  FULL_CROP_RECT,
  moveCropRect,
  nextRotation,
  resizeCropRect,
  rotatedDimensions,
} from './cropMath';
import type { Corner, CropRect, Rotation } from './cropMath';
import { mergeLabels } from '../labels';
import type { DeepPartial, PhotoCropEditorLabels } from '../labels';
import styles from './PhotoCropEditor.module.css';

export interface PhotoCropEditorProps {
  imageUrl: string;
  /** True while a save is in flight — disables the controls so a double-click can't fire two requests. */
  saving: boolean;
  onCancel: () => void;
  /** Receives the final cropped/rotated image as a Blob, ready to upload as-is. */
  onSave: (blob: Blob) => void;
  labels?: DeepPartial<PhotoCropEditorLabels>;
}

type DragMode = { type: 'move' } | { type: 'resize'; corner: Corner };

/**
 * The crop "stage" is capped to this box, but ALWAYS resized down to the
 * image's (or, once rotated, the rotated image's) own aspect ratio inside
 * it — see containBox() in cropMath.ts. This is deliberate: the stage
 * must never letterbox the image, because the crop rectangle is
 * positioned in percentages OF THE STAGE, and computeCropPixelRegion()
 * interprets those same percentages as fractions OF THE IMAGE. Those two
 * only agree if the stage IS the image's displayed box, pixel-perfect —
 * a fixed-aspect-ratio stage with the image shrunk to fit inside it
 * silently produces a WRONG crop region for any image that isn't exactly
 * this box's own ratio, which is most real photos, portrait phone photos
 * especially.
 *
 * That "pixel-perfect" claim depends on ONE more thing beyond the
 * `<img>`'s inline width/height below: PhotoCropEditor.module.css's
 * `.image` rule MUST reset `max-width`/`max-height` to `none`. See that
 * CSS rule's own comment for the full derivation — this specific
 * invariant is not observable in JSDOM at all (no layout engine), only
 * under a real browser; see the README's Limitations section.
 */
/**
 * Upper bound on the stage size on a roomy desktop screen — NOT the only
 * constraint. On a phone-width viewport this cap alone can leave a large
 * fraction of a landscape source unreachable (the crop rect's own
 * handles are inside the stage, and the stage cannot be panned), which
 * matters a great deal for a component whose primary input device, for
 * many consumers, is a phone camera roll. `availableStageBox()` below
 * combines this cap with the ACTUAL viewport size so the stage is never
 * larger than what genuinely fits — see the effect that tracks
 * `window.innerWidth/Height`.
 */
const MAX_STAGE_WIDTH = 640;
const MAX_STAGE_HEIGHT = 480;

/**
 * Approximates the headroom the overlay/dialog padding in
 * PhotoCropEditor.module.css reserves around the stage (8px + 16px on
 * each side) — an approximation (doesn't account for the hint text/
 * error/actions rows' own height), not a pixel-exact layout replica, but
 * enough to keep the stage from ever exceeding the space actually
 * visible around it on a small viewport. Real on-screen fit can only be
 * verified with a real layout engine (Playwright or a human), not by
 * this arithmetic alone — see this component's own module doc and the
 * README's Limitations section.
 */
function availableStageBox(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
  const horizontalChrome = 2 * (8 + 16); // overlay + dialog padding, both sides
  const width = Math.min(MAX_STAGE_WIDTH, viewportWidth * 0.9 - horizontalChrome);
  const height = Math.min(MAX_STAGE_HEIGHT, viewportHeight * 0.55);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Click-to-crop editor: a modal overlay showing the full image with a
 * draggable/resizable crop rectangle, plus 90°-step rotate buttons. All
 * the actual geometry (clamping, corner-drag math, rotated pixel
 * regions, stage sizing) lives in cropMath.ts as plain, DOM-free
 * functions — this component is just the pointer-event glue and the
 * final canvas render on Save.
 *
 * Hand-rolled rather than a crop library: the interaction is a single
 * move+resize rectangle with 90° rotation, well within what a few dozen
 * lines of pointer-event handling and two <canvas> draws can do, so a
 * new dependency wasn't judged worth it (see cropMath.ts's parallel
 * reasoning).
 *
 * The result is a Blob this component hands to `onSave` — it never
 * claims to produce the FINAL stored bytes itself. A typical backend
 * runs it through a server-side conversion pipeline before storing it;
 * see docs/server-contract.md for what that pipeline needs to do
 * (WebP conversion, a size cap that must match MAX_OUTPUT_DIMENSION_PX
 * below, HEIC handling).
 *
 * Encoding choice: a lossless PNG of an unmodified multi-megapixel photo
 * can approach a typical upload size cap on its own, before the server
 * even gets a chance to recompress it — that's the reason to encode
 * WebP here instead of PNG. But WebP-then-WebP (this step, then a
 * server's own lossy re-encode) is a SECOND lossy generation on every
 * crop-save, compounding visible artifacts a single generation wouldn't
 * have. WEBP_OUTPUT_QUALITY is pinned high (0.92) specifically to keep
 * that second-generation loss close to imperceptible while staying
 * roughly an order of magnitude smaller than PNG for the same visual
 * result — genuinely lossless output was considered and rejected: it
 * reopens the exact upload-size-cap risk this encoding choice exists to
 * avoid, for a quality gain a server-side re-encode already gives away
 * regardless of how pristine the upload was. Browsers without canvas
 * WebP-encode support (older Safari) fall back to PNG automatically per
 * the toBlob() spec — the same upload-size caveat applies there.
 */
const WEBP_OUTPUT_QUALITY = 0.92;

/**
 * Cap on the output canvas's longest side, BEFORE `toBlob`. This number
 * MUST match whatever maximum dimension your backend's own image
 * pipeline resizes to (the reference backend this package was extracted
 * from uses 2400px with sharp's `resize({ fit: 'inside' })`) — the two
 * are not linked by any shared import (this is a frontend-only package),
 * so keeping them equal is the consuming application's responsibility.
 * See docs/server-contract.md for the full reasoning: capping lower than
 * the server's own cap throws away quality the server was willing to
 * keep; capping higher is pure waste (encoded client-side, uploaded,
 * decoded server-side, and immediately discarded). A full-resolution
 * crop from a modern phone photo can cost several seconds and several
 * megabytes to encode uncapped, for a pixel-identical final result once
 * the server downsizes it anyway — capping client-side avoids paying
 * that cost at all.
 */
export const MAX_OUTPUT_DIMENSION_PX = 2400;

/**
 * Scales `width x height` down to fit within `maxDimension` on its longest
 * side, preserving aspect ratio exactly (both dimensions scaled by the
 * same factor). Never upscales — a region already at or under the cap on
 * both sides is returned completely unchanged (not just "close": the exact
 * same numbers), so a small crop's output canvas is byte-for-byte the same
 * size it always was.
 */
function capOutputSize(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return { width, height };
  }
  const scale = maxDimension / longestSide;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function PhotoCropEditor({ imageUrl, saving, onCancel, onSave, labels }: PhotoCropEditorProps) {
  const t = mergeLabels({ cropEditor: labels }).cropEditor;

  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: DragMode; startX: number; startY: number; startRect: CropRect } | null>(null);

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP_RECT);
  const [error, setError] = useState<string | null>(null);
  // Tracked so the stage can shrink to fit a phone viewport instead of
  // only ever using the fixed MAX_STAGE_WIDTH/HEIGHT desktop cap — see
  // availableStageBox() above. `resize` also covers a phone's
  // orientation change (which fires it in every evergreen browser).
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  useEffect(() => {
    function onResize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    setCrop(FULL_CROP_RECT);
  }

  function handleRotate(direction: 1 | -1) {
    setRotation((current) => nextRotation(current, direction));
    // Width/height swap on rotation — a crop fraction chosen for a
    // landscape frame rarely makes sense once the frame is portrait, so
    // reset to full-frame rather than carry over a now-meaningless rect.
    setCrop(FULL_CROP_RECT);
  }

  // The box the crop rect's percentages are measured against — see the
  // MAX_STAGE_WIDTH/HEIGHT and availableStageBox() comments above.
  // Recomputed from the CURRENT rotation AND viewport on every render
  // (cheap, pure) rather than cached in state, so it can never drift out
  // of sync with either.
  const maxBox = availableStageBox(viewport.width, viewport.height);
  const rotated = naturalSize ? rotatedDimensions(naturalSize.width, naturalSize.height, rotation) : null;
  const stageBox = rotated ? containBox(rotated.width, rotated.height, maxBox.width, maxBox.height) : maxBox;
  // The <img> itself keeps its UNROTATED intrinsic aspect ratio; it's
  // rendered at the size that, once CSS-rotated around its own center,
  // produces a bounding box exactly equal to stageBox (a 90°/270° visual
  // rotation of a W×H box has a footprint of H×W) — this is what makes
  // the on-screen preview during rotation match what computeCropPixelRegion
  // will actually cut, instead of merely spinning the image inside its
  // old, now-wrong-shaped box.
  const imageRenderSize =
    rotation === 90 || rotation === 270 ? { width: stageBox.height, height: stageBox.width } : stageBox;

  function fractionDelta(dxPx: number, dyPx: number): { dx: number; dy: number } {
    const stage = stageRef.current;
    const width = stage?.clientWidth || 1;
    const height = stage?.clientHeight || 1;
    return { dx: dxPx / width, dy: dyPx / height };
  }

  /**
   * `handlePointerMove`/`endDrag` are memoized with an EMPTY dependency
   * array — deliberately, and safely, because everything they touch is
   * either a ref (`dragRef`, `stageRef`, both always current regardless
   * of which render's closure reads them) or a stable setState setter
   * (`setCrop`) or a pure import (`moveCropRect`/`resizeCropRect`/
   * `fractionDelta`, itself ref-only). A plain (non-memoized) version of
   * these gets a NEW function identity every render;
   * `window.addEventListener('pointermove', handlePointerMove)` in
   * `beginDrag` then registers whichever render's closure was current
   * when a drag STARTED, but `useEffect(() => endDrag, [])`'s cleanup
   * (below) only ever runs ONCE, capturing the FIRST render's `endDrag`/
   * `handlePointerMove` identities — so if a drag began on any LATER
   * render, unmounting mid-drag calls `removeEventListener` with a
   * function reference that was never the one actually added, leaking
   * both `window` listeners past unmount. Memoizing with `[]` gives both
   * functions ONE stable identity for the component's whole lifetime, so
   * add/remove always agree, in `beginDrag`, in `endDrag` itself, and in
   * the unmount effect below, regardless of which render triggered which.
   */
  const handlePointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { dx, dy } = fractionDelta(event.clientX - drag.startX, event.clientY - drag.startY);
    setCrop(
      drag.mode.type === 'move'
        ? moveCropRect(drag.startRect, dx, dy)
        : resizeCropRect(drag.startRect, drag.mode.corner, dx, dy),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [handlePointerMove]);

  function beginDrag(mode: DragMode) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = { mode, startX: event.clientX, startY: event.clientY, startRect: crop };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endDrag);
    };
  }

  // Pointer listeners are attached to `window` only while a drag is
  // active (added/removed in beginDrag/endDrag), but also torn down on
  // unmount in case the component disappears mid-drag (e.g. the whole
  // form navigates away) — safe to remove unconditionally even when no
  // drag was in progress (removing a listener that was never added is a
  // silent no-op). Depends on `endDrag`, but that's stable (see above),
  // so this still only actually needs to run its cleanup once, on
  // unmount, not on every render.
  useEffect(() => endDrag, [endDrag]);

  /**
   * A pointerdown that starts outside the dialog (never one that bubbled
   * up from a child, and never a synthetic click fired on release — see
   * the module doc below) closes the editor. Using pointerDOWN rather
   * than a `click` handler on the overlay is deliberate: a crop handle
   * drag that STARTS inside the dialog and is released (pointerup) over
   * the backdrop still fires a browser `click` on their nearest common
   * ancestor, which used to be this overlay — discarding whatever the
   * user was mid-drag on. Keying off pointerdown instead means only a
   * press that genuinely begins outside the dialog can ever close it.
   *
   * "Outside the dialog" is a CONTAINMENT check (`!dialogRef.current
   * ?.contains(event.target)`), not an `event.target === event.currentTarget`
   * identity check against the overlay. Identity comparison is known to
   * fail on WebKit in some circumstances: a press on a corner handle can
   * retarget `event.target` to (or through) the overlay, which an
   * identity check has no way to distinguish from a genuine backdrop
   * press — closing the whole dialog instead of starting a drag. A
   * containment check has no such failure mode: a handle is a descendant
   * of `.dialog` however the target got retargeted, so it can never be
   * treated as "outside", on any engine.
   *
   * Two more guards, both cheap and here deliberately:
   *  - `event.button !== 0` — ignore anything but a primary-button press,
   *    so a right-click (which is really "open a context menu", button 2)
   *    can't also dismiss the dialog as a side effect. Touch/pen report
   *    `button === 0` for their primary contact, so this doesn't affect
   *    tap-to-dismiss on a phone.
   *  - `dragRef.current` — while a drag is in flight, a pointerdown on the
   *    backdrop is essentially guaranteed to be a stray/duplicate event
   *    (a second pointer, a platform quirk) rather than a genuine new
   *    press with intent to cancel; a drag already owns pointer input via
   *    its own window listeners, so let it, rather than the backdrop,
   *    decide what happens.
   */
  function handleBackdropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    if (event.button !== 0) return;
    if (!dialogRef.current?.contains(event.target as Node)) onCancel();
  }

  function handleSave() {
    const img = imgRef.current;
    if (!img || !naturalSize) return;
    setError(null);

    const { width: rotatedWidth, height: rotatedHeight } = rotatedDimensions(naturalSize.width, naturalSize.height, rotation);
    const rotatedCanvas = document.createElement('canvas');
    rotatedCanvas.width = rotatedWidth;
    rotatedCanvas.height = rotatedHeight;
    const rotatedCtx = rotatedCanvas.getContext('2d');
    if (!rotatedCtx) {
      setError(t.canvasUnsupported);
      return;
    }
    rotatedCtx.save();
    if (rotation === 90) {
      rotatedCtx.translate(rotatedWidth, 0);
      rotatedCtx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      rotatedCtx.translate(rotatedWidth, rotatedHeight);
      rotatedCtx.rotate(Math.PI);
    } else if (rotation === 270) {
      rotatedCtx.translate(0, rotatedHeight);
      rotatedCtx.rotate(-Math.PI / 2);
    }
    rotatedCtx.drawImage(img, 0, 0, naturalSize.width, naturalSize.height);
    rotatedCtx.restore();

    const region = computeCropPixelRegion(naturalSize.width, naturalSize.height, rotation, crop);
    // Downscale happens HERE, not on the server: the output canvas is sized
    // to the capped dimensions (never larger than the crop region itself —
    // see capOutputSize()'s "never upscale" guarantee), and the single
    // drawImage call below does the crop AND the downscale in one step by
    // giving it a source rect (the natural-resolution region) and a
    // SMALLER destination rect — no extra intermediate canvas, so the
    // browser's own (better-than-hand-rolled) scaler does strictly less
    // work than encoding the full-resolution region would, not more.
    const outputSize = capOutputSize(region.width, region.height, MAX_OUTPUT_DIMENSION_PX);
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = outputSize.width;
    outputCanvas.height = outputSize.height;
    const outputCtx = outputCanvas.getContext('2d');
    if (!outputCtx) {
      setError(t.canvasUnsupported);
      return;
    }
    outputCtx.imageSmoothingQuality = 'high';
    outputCtx.drawImage(
      rotatedCanvas,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      outputSize.width,
      outputSize.height,
    );

    outputCanvas.toBlob(
      (blob) => {
        if (!blob) {
          setError(t.saveFailed);
          return;
        }
        onSave(blob);
      },
      'image/webp',
      WEBP_OUTPUT_QUALITY,
    );
  }

  // Shared by .cropRect (interactive, unclipped, holds the handles) and
  // .dimRect (purely visual, clipped to the stage) so the two can never
  // drift apart into two different rectangles on screen.
  const cropRectStyle = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
  };

  const hasChanges = crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1 || rotation !== 0;

  // Nothing changed — closing must be a pure no-op, not a re-encode +
  // re-upload of byte-identical pixels (which would also needlessly bump
  // a "last modified" timestamp and bust a perfectly good cache entry for
  // no visual change).
  function handleSaveOrClose() {
    if (!hasChanges) {
      onCancel();
      return;
    }
    handleSave();
  }

  return (
    <div className={styles.overlay} role="presentation" onPointerDown={handleBackdropPointerDown}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={t.dialogLabel}>
        <div ref={stageRef} className={styles.stage} style={{ width: stageBox.width, height: stageBox.height }}>
          {/* Image clipping lives on THIS inner wrapper, not .stage itself —
              see .imageClip's own comment for why: the crop rect's corner
              handles sit half outside the image at the default full-frame
              crop (by design, so a corner is always grabbable even when
              cropping flush to an edge), and clipping .stage directly made
              them invisible/unclickable in a REAL browser (JSDOM's
              fireEvent dispatches directly on a target regardless of any
              clip, so this was invisible to a JSDOM-only suite). */}
          <div className={styles.imageClip}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative, the dialog itself is labelled */}
            <img
              ref={imgRef}
              src={imageUrl}
              alt=""
              className={styles.image}
              style={{
                width: imageRenderSize.width,
                height: imageRenderSize.height,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
              onLoad={handleImageLoad}
            />
          </div>
          {naturalSize && (
            <>
              {/* Purely visual dimming, clipped to the stage — see
                  .dimClip's own comment in the CSS module for why this
                  has to be a separate, pointer-events:none layer rather
                  than a box-shadow on .cropRect itself. Shares the exact
                  same left/top/width/height as .cropRect below (one
                  `cropRectStyle` object) so the dimming still tracks the
                  crop rect pixel-for-pixel. */}
              <div className={styles.dimClip}>
                <div className={styles.dimRect} style={cropRectStyle} />
              </div>
              <div className={styles.cropRect} style={cropRectStyle} onPointerDown={beginDrag({ type: 'move' })}>
                {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                  <div
                    key={corner}
                    className={`${styles.handle} ${styles[`handle-${corner}`]}`}
                    onPointerDown={beginDrag({ type: 'resize', corner })}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <p className={styles.hint}>{t.hint}</p>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <div className={styles.rotateGroup}>
            <button type="button" onClick={() => handleRotate(-1)} disabled={saving} aria-label={t.rotateLeftAria}>
              {t.rotateLeftText}
            </button>
            <button type="button" onClick={() => handleRotate(1)} disabled={saving} aria-label={t.rotateRightAria}>
              {t.rotateRightText}
            </button>
          </div>
          <div className={styles.mainGroup}>
            <button type="button" className={styles.cancelButton} onClick={onCancel} disabled={saving}>
              {t.cancel}
            </button>
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleSaveOrClose}
              disabled={hasChanges ? saving || !naturalSize : saving}
            >
              {saving ? t.saving : hasChanges ? t.save : t.close}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
