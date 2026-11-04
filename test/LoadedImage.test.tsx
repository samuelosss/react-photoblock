import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadedImage } from '../src/components/LoadedImage';

/**
 * The injection point that exists because an `<img src>` cannot send a
 * request header. The package must never learn what a bearer token is —
 * these tests assert only that it calls the injected function and renders
 * what comes back, and that with the prop ABSENT nothing changes at all.
 */
describe('LoadedImage', () => {
  it('renders a plain <img src> and calls nothing when no loadImage is supplied', () => {
    render(<LoadedImage src="/api/admin/images/10?v=1" alt="" data-testid="img" />);
    const img = screen.getByTestId('img');
    expect(img.getAttribute('src')).toBe('/api/admin/images/10?v=1');
    expect(img.getAttribute('data-pb-image-state')).toBe('ready');
  });

  it('routes the src through loadImage and renders the resulting object URL', async () => {
    const loadImage = vi.fn(() => Promise.resolve(new Blob(['bytes'], { type: 'image/webp' })));
    render(<LoadedImage src="/api/admin/images/10?v=1" loadImage={loadImage} alt="" data-testid="img" />);

    expect(loadImage).toHaveBeenCalledWith('/api/admin/images/10?v=1');
    await waitFor(() => expect(screen.getByTestId('img').getAttribute('data-pb-image-state')).toBe('ready'));
    // The vitest setup's createObjectURL fake returns a blob: URL.
    expect(screen.getByTestId('img').getAttribute('src')).toMatch(/^blob:/);
  });

  /**
   * THE SHIPPED-AND-REVERTED BUG in the origin project was handing the
   * `<img>` the raw credentialed URL, which 401s and renders broken. If
   * this component ever stops routing through `loadImage`, the src stays
   * the original URL and this fails.
   */
  it('never leaves the raw src on the <img> while loadImage is handling it', () => {
    let resolve: ((blob: Blob) => void) | undefined;
    const loadImage = vi.fn(() => new Promise<Blob>((r) => (resolve = r)));
    render(<LoadedImage src="/api/admin/images/10" loadImage={loadImage} alt="" data-testid="img" />);

    const img = screen.getByTestId('img');
    expect(img.getAttribute('data-pb-image-state')).toBe('loading');
    // No `src` ATTRIBUTE at all — an <img> with none renders empty, not
    // as the broken-image icon.
    expect(img.hasAttribute('src')).toBe(false);
    expect(resolve).toBeTypeOf('function');
  });

  /**
   * PASS-THROUGH IS LOAD-BEARING. A photo queued before the first save is
   * previewed from `URL.createObjectURL(file)`; fetching that through a
   * consumer's auth layer would break the instant-preview path. The
   * exclusion is structural, not a convention the consumer has to
   * remember.
   */
  it.each(['blob:http://localhost/abc-123', 'data:image/png;base64,AAAA'])(
    'never calls loadImage for the package\'s own local preview URL (%s)',
    (src) => {
      const loadImage = vi.fn(() => Promise.resolve(new Blob(['x'])));
      render(<LoadedImage src={src} loadImage={loadImage} alt="" data-testid="img" />);

      expect(loadImage).not.toHaveBeenCalled();
      expect(screen.getByTestId('img').getAttribute('src')).toBe(src);
    },
  );

  it('renders the src directly when loadImage returns null ("not mine")', () => {
    const loadImage = vi.fn(() => null);
    render(<LoadedImage src="/public/images/10" loadImage={loadImage} alt="" data-testid="img" />);

    expect(loadImage).toHaveBeenCalledWith('/public/images/10');
    expect(screen.getByTestId('img').getAttribute('src')).toBe('/public/images/10');
    expect(screen.getByTestId('img').getAttribute('data-pb-image-state')).toBe('ready');
  });

  it('renders an <img> with no src — not a broken-image icon — when loadImage rejects', async () => {
    const loadImage = vi.fn(() => Promise.reject(new Error('401')));
    render(<LoadedImage src="/api/admin/images/10" loadImage={loadImage} alt="" data-testid="img" />);

    await waitFor(() => expect(screen.getByTestId('img').getAttribute('data-pb-image-state')).toBe('error'));
    expect(screen.getByTestId('img').hasAttribute('src')).toBe(false);
    // Still a real <img>: every selector that reasonably expects an image
    // to be an <img> keeps working.
    expect(screen.getByTestId('img').tagName).toBe('IMG');
  });

  it('revokes the object URL on unmount, so a grid of these does not pin blobs in memory', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const loadImage = vi.fn(() => Promise.resolve(new Blob(['bytes'])));
    const { unmount } = render(<LoadedImage src="/api/admin/images/10" loadImage={loadImage} alt="" data-testid="img" />);

    await waitFor(() => expect(screen.getByTestId('img').getAttribute('data-pb-image-state')).toBe('ready'));
    const objectUrl = screen.getByTestId('img').getAttribute('src');
    unmount();
    expect(revoke).toHaveBeenCalledWith(objectUrl);
    revoke.mockRestore();
  });
});
