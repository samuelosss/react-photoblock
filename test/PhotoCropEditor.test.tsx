import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoCropEditor } from '../src/components/PhotoCropEditor';
import { containBox, resizeCropRect, computeCropPixelRegion, FULL_CROP_RECT } from '../src/components/cropMath';
import styles from '../src/components/PhotoCropEditor.module.css';

/**
 * JSDOM implements neither real <canvas> rendering nor real image
 * decoding — Save's canvas draw calls and the <img>'s onLoad both need
 * stand-ins. The stand-ins are pure behavioural doubles (record calls,
 * hand back a fixed Blob) rather than anything that re-implements the
 * crop math itself, so a test that exercises them is still testing THIS
 * component's wiring (does it call getContext/drawImage/toBlob and
 * forward the result to onSave?), not re-asserting a constant.
 * `drawImage`'s actual ARGUMENTS are asserted below — that's what proves
 * the crop region is computed correctly, not just that some call
 * happened.
 */
function stubCanvas() {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb) {
    cb(new Blob(['fake-webp-bytes'], { type: 'image/webp' }));
  });
  return ctx;
}

function loadImage(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(img);
}

/** JSDOM never computes real layout, so the stage's clientWidth/Height
 *  (what fractionDelta divides by) has to be told what a real browser
 *  would have rendered — see containBox()'s own tests for proof that
 *  THAT calculation is correct in isolation; this proves the
 *  DOM-measurement + drag-math + canvas-call wiring around it is too. */
function mockStageSize(stageEl: Element, width: number, height: number) {
  Object.defineProperty(stageEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(stageEl, 'clientHeight', { value: height, configurable: true });
}

function dragHandle(handleEl: Element, dxPx: number, dyPx: number) {
  fireEvent.pointerDown(handleEl, { clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: dxPx, clientY: dyPx });
  fireEvent.pointerUp(window, { clientX: dxPx, clientY: dyPx });
}

/**
 * PhotoCropEditor shrinks its stage to fit the viewport, so most tests
 * here mock a roomy desktop viewport to keep the MAX_STAGE_WIDTH/HEIGHT
 * hard caps (640×480) as the effective ones — the responsive-shrink
 * behavior itself gets its own dedicated tests below. NOTE: JSDOM has no
 * layout engine, so this only proves the component's OWN arithmetic
 * responds to window.innerWidth/Height — it cannot prove the resulting
 * stage actually fits a real phone screen; see the README's Limitations
 * section.
 */
function mockViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

beforeEach(() => {
  stubCanvas();
  mockViewport(2000, 2000); // roomy desktop — the 640×480 hard caps bind
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PhotoCropEditor', () => {
  it('renders as a labelled modal dialog', () => {
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Edit photo' })).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on a press that starts directly on the backdrop, but NOT one starting inside the dialog', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onCancel).not.toHaveBeenCalled();

    const [backdrop] = screen.getAllByRole('presentation');
    fireEvent.pointerDown(backdrop!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression: a crop-handle drag that starts inside the dialog but is
   * released (pointerup) over the backdrop used to fire a browser `click`
   * on the nearest common ancestor — the overlay — discarding the edit.
   * Closing is keyed off pointerDOWN, which for a drag only ever fires on
   * the handle itself, never the backdrop, so this must NOT close the
   * editor.
   */
  it('does NOT close when a drag that started on a handle ends (pointerup) over the backdrop', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 1800, 2400);
    const stage = img.parentElement!.parentElement!; // <img> -> .imageClip -> .stage
    mockStageSize(stage, 360, 480);
    const handle = stage.getElementsByClassName(styles['handle-se']!)[0]!;

    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    // Released far outside the dialog entirely — simulates the pointerup
    // landing on the backdrop.
    fireEvent.pointerUp(window, { clientX: 9999, clientY: 9999 });
    const [backdrop] = screen.getAllByRole('presentation');
    fireEvent.click(backdrop!); // the synthetic click this used to trigger

    expect(onCancel).not.toHaveBeenCalled();
  });

  /**
   * The corner handles must stay grabbable via a containment check
   * against the dialog, rather than an identity check against the
   * overlay's own currentTarget — see PhotoCropEditor.tsx's
   * handleBackdropPointerDown doc for why event-target identity can't be
   * trusted for this. This proves the JSDOM-observable half: a
   * pointerdown that starts on a handle is INSIDE the dialog, so it can
   * never be treated as "outside".
   */
  it.each(['nw', 'ne', 'se', 'sw'] as const)(
    'pointerdown on the %s corner handle begins a drag and does NOT close the dialog',
    (corner) => {
      const onCancel = vi.fn();
      render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
      const img = screen.getByAltText('') as HTMLImageElement;
      loadImage(img, 1600, 1200);
      const stage = img.parentElement!.parentElement!; // <img> -> .imageClip -> .stage
      mockStageSize(stage, 400, 300);
      const handle = stage.getElementsByClassName(styles[`handle-${corner}`]!)[0]!;
      const cropRectEl = stage.getElementsByClassName(styles.cropRect!)[0] as HTMLElement;

      // Move genuinely INWARD from this corner's starting position, so a
      // no-op drag (which would also leave onCancel uncalled, proving
      // nothing) can't masquerade as a real one.
      const inward: Record<typeof corner, { dx: number; dy: number }> = {
        nw: { dx: 40, dy: 40 },
        ne: { dx: -40, dy: 40 },
        se: { dx: -40, dy: -40 },
        sw: { dx: 40, dy: -40 },
      };
      dragHandle(handle, inward[corner].dx, inward[corner].dy);

      expect(onCancel).not.toHaveBeenCalled();
      // Proves a drag genuinely happened — not merely "didn't cancel",
      // which an inert press would also satisfy.
      expect(cropRectEl.style.width).not.toBe('100%');
    },
  );

  it('ignores a non-primary-button pointerdown on the actual backdrop (e.g. a right-click) — only a primary press dismisses', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    const [backdrop] = screen.getAllByRole('presentation');
    fireEvent.pointerDown(backdrop!, { button: 2 });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a pointerdown on the backdrop while a drag is already in flight does not dismiss the dialog (a drag owns pointer input)', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 1600, 1200);
    const stage = img.parentElement!.parentElement!;
    mockStageSize(stage, 400, 300);
    const handle = stage.getElementsByClassName(styles['handle-se']!)[0]!;

    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 }); // drag begins; dragRef is now set
    const [backdrop] = screen.getAllByRole('presentation');
    fireEvent.pointerDown(backdrop!); // a stray second pointer while the drag owns input
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 }); // clean up the in-flight drag
  });

  it('a drag that starts inside the stage and is released outside the dialog leaves the editor open', () => {
    const onCancel = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 1600, 1200);
    const stage = img.parentElement!.parentElement!;
    mockStageSize(stage, 400, 300);
    const cropRectEl = stage.getElementsByClassName(styles.cropRect!)[0]!;

    fireEvent.pointerDown(cropRectEl, { clientX: 100, clientY: 100 }); // move-drag on the rect itself
    fireEvent.pointerMove(window, { clientX: 9999, clientY: 9999 }); // dragged far outside the dialog
    fireEvent.pointerUp(window, { clientX: 9999, clientY: 9999 }); // released outside the dialog

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit photo' })).toBeInTheDocument();
  });

  it('shows "Close" (not a Save label) until the user actually rotates or crops — clicking it is a plain close, not a save', () => {
    const onSave = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' }));
    expect(screen.getByRole('button', { name: 'Save edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('"Close" is a pure no-op close — no canvas work, no onSave, when nothing changed', () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={onCancel} onSave={onSave} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 800, 600);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('produces a Blob and hands it to onSave once an actual change (rotate) is made', () => {
    const onSave = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={onSave} />);

    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 800, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it('disables every control while saving, so a double-click cannot fire twice', () => {
    render(<PhotoCropEditor imageUrl="/images/5" saving={true} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rotate left 90°' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rotate right 90°' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('surfaces a visible error, without crashing, when the browser has no canvas support', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onSave = vi.fn();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={onSave} />);

    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 800, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' })); // force an actual save attempt
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/does not support/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('encodes the saved Blob as WebP (not PNG) — an order of magnitude smaller for a typical upload size cap', () => {
    const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 800, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    // Pinned to the exact value, not expect.any(Number) — this is a real
    // tradeoff (see the component's own "Encoding choice" doc: WebP-then-
    // WebP is a second lossy generation on top of a server's own
    // re-encode, so the quality picked here is deliberate, not free to
    // drift silently).
    expect(toBlobSpy).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.92);
  });

  it('supports overriding labels', () => {
    render(
      <PhotoCropEditor
        imageUrl="/images/5"
        saving={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        labels={{ dialogLabel: 'Upravit fotku', cancel: 'Zrušit' }}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Upravit fotku' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zrušit' })).toBeInTheDocument();
    // Untouched labels keep their English default.
    expect(screen.getByRole('button', { name: 'Rotate right 90°' })).toBeInTheDocument();
  });
});

/**
 * These are pure-function WIRING tests, not proof of the real-CSS-layout
 * invariant (that a fraction of the crop rect equals the same fraction
 * of the actual rendered image). They recompute their "expected" value
 * via the SAME pure functions (containBox/resizeCropRect/
 * computeCropPixelRegion) the component itself calls, and mock
 * `clientWidth`/`clientHeight` to match — so a bug INSIDE those
 * functions, or a disagreement between their output and what a REAL
 * browser actually lays out (e.g. a CSS `max-width` clamp silently
 * overriding an inline size), is invisible to a test that uses the same
 * function to build both sides of its own comparison. What these tests
 * DO catch honestly: wiring regressions — does the component still call
 * containBox() at all when sizing the stage, still feed a real drag's
 * pixel delta through resizeCropRect(), still derive the canvas draw
 * region from computeCropPixelRegion()? cropMath.ts's own pure-function
 * correctness is covered separately by cropMath.test.ts. The actual
 * on-screen, real-CSS-cascade invariant can only be proven under a real
 * layout engine — see the README's Limitations section; this package's
 * Playwright specs under e2e/ cover it in headless Chromium.
 */
describe('PhotoCropEditor — pure-function wiring (not the real-CSS-layout invariant)', () => {
  const MAX_STAGE_WIDTH = 640;
  const MAX_STAGE_HEIGHT = 480;

  it.each([
    { name: 'portrait', naturalWidth: 1800, naturalHeight: 2400 },
    { name: 'landscape', naturalWidth: 2400, naturalHeight: 1800 },
    { name: '16:9', naturalWidth: 1920, naturalHeight: 1080 },
  ])("calls containBox() with the $name image's natural dimensions and applies its result as the stage's inline size", ({ naturalWidth, naturalHeight }) => {
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, naturalWidth, naturalHeight);
    const stage = img.parentElement!.parentElement as HTMLElement; // <img> -> .imageClip -> .stage

    const expected = containBox(naturalWidth, naturalHeight, MAX_STAGE_WIDTH, MAX_STAGE_HEIGHT);
    expect(stage.style.width).toBe(`${expected.width}px`);
    expect(stage.style.height).toBe(`${expected.height}px`);
    // The failure mode this guards against: a fixed 4:3 stage regardless
    // of image shape.
    if (Math.abs(naturalWidth / naturalHeight - MAX_STAGE_WIDTH / MAX_STAGE_HEIGHT) > 0.01) {
      expect(expected.width === MAX_STAGE_WIDTH && expected.height === MAX_STAGE_HEIGHT).toBe(false);
    }
  });

  it('feeds a narrower viewport into containBox() and applies the smaller result (responsive-shrink wiring — real-viewport fit is Playwright-only, see e2e/)', () => {
    mockViewport(390, 800); // a typical narrow phone viewport
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, 4000, 3000);
    const stage = img.parentElement!.parentElement as HTMLElement; // <img> -> .imageClip -> .stage

    const stageWidthPx = Number.parseFloat(stage.style.width);
    expect(stageWidthPx).toBeLessThan(MAX_STAGE_WIDTH);
    expect(stageWidthPx).toBeLessThanOrEqual(390);
  });

  const cases: Array<{ name: string; naturalWidth: number; naturalHeight: number }> = [
    { name: 'portrait', naturalWidth: 1800, naturalHeight: 2400 },
    { name: 'landscape', naturalWidth: 2400, naturalHeight: 1800 },
    { name: 'square', naturalWidth: 1000, naturalHeight: 1000 },
    { name: '16:9', naturalWidth: 1920, naturalHeight: 1080 },
  ];

  it.each(cases)('feeds a drag on a $name source through resizeCropRect()/computeCropPixelRegion() into the drawImage call (pipeline wiring, not real layout)', ({ naturalWidth, naturalHeight }) => {
    const ctx = stubCanvas();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    loadImage(img, naturalWidth, naturalHeight);
    const stage = img.parentElement!.parentElement!; // <img> -> .imageClip -> .stage

    const stageBox = containBox(naturalWidth, naturalHeight, MAX_STAGE_WIDTH, MAX_STAGE_HEIGHT);
    mockStageSize(stage, stageBox.width, stageBox.height);

    const handle = stage.getElementsByClassName(styles['handle-se']!)[0]!;
    const dxPx = -(stageBox.width * 0.2);
    const dyPx = -(stageBox.height * 0.1);
    dragHandle(handle, dxPx, dyPx);

    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    const expectedCrop = resizeCropRect(FULL_CROP_RECT, 'se', dxPx / stageBox.width, dyPx / stageBox.height);
    const expectedRegion = computeCropPixelRegion(naturalWidth, naturalHeight, 0, expectedCrop);

    const drawImageCalls = ctx.drawImage.mock.calls;
    const cropDrawCall = drawImageCalls[drawImageCalls.length - 1]!; // the 9-arg output-canvas draw
    expect(cropDrawCall).toHaveLength(9);
    expect(cropDrawCall.slice(1, 5)).toEqual([expectedRegion.x, expectedRegion.y, expectedRegion.width, expectedRegion.height]);
  });

  it('a 90° rotation followed by a crop still cuts the ROTATED region, not the pre-rotation one', () => {
    const ctx = stubCanvas();
    render(<PhotoCropEditor imageUrl="/images/5" saving={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    const img = screen.getByAltText('') as HTMLImageElement;
    const naturalWidth = 1000;
    const naturalHeight = 500;
    loadImage(img, naturalWidth, naturalHeight);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' }));

    const stage = img.parentElement!.parentElement!; // <img> -> .imageClip -> .stage
    // Rotated: displays/crops as 500x1000 — stage matches THAT ratio.
    const stageBox = containBox(naturalHeight, naturalWidth, MAX_STAGE_WIDTH, MAX_STAGE_HEIGHT);
    mockStageSize(stage, stageBox.width, stageBox.height);

    const handle = stage.getElementsByClassName(styles['handle-se']!)[0]!;
    const dxPx = -(stageBox.width * 0.3); // inward, shrinking from the full-frame default
    dragHandle(handle, dxPx, 0);

    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    const expectedCrop = resizeCropRect(FULL_CROP_RECT, 'se', dxPx / stageBox.width, 0);
    const expectedRegion = computeCropPixelRegion(naturalWidth, naturalHeight, 90, expectedCrop);
    expect(expectedRegion.rotatedWidth).toBe(500); // sanity: rotation did swap dims
    expect(expectedRegion.rotatedHeight).toBe(1000);

    const drawImageCalls = ctx.drawImage.mock.calls;
    const cropDrawCall = drawImageCalls[drawImageCalls.length - 1]!;
    expect(cropDrawCall.slice(1, 5)).toEqual([expectedRegion.x, expectedRegion.y, expectedRegion.width, expectedRegion.height]);
  });
});
