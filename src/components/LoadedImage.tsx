import { useEffect, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';

/**
 * An optional hook for fetching an image's bytes yourself instead of
 * letting the browser do it.
 *
 * WHY THIS EXISTS AT ALL — and it is worth knowing before you reach for
 * it, because a consumer always asks. **An `<img src>` cannot send a
 * request header.** If your thumbnails live behind an endpoint that
 * requires one — `Authorization: Bearer …` being the usual case, because
 * the person editing a draft must be able to see photos the public
 * cannot — then pointing an `<img>` straight at those URLs makes every
 * thumbnail 401 and render as a broken image. The browser has no way to
 * attach the credential to an image request.
 *
 * A TOKEN IN THE QUERY STRING IS NOT THE ALTERNATIVE. `?token=…` looks
 * like the easy fix and is not one: reverse proxies log full request
 * lines, so it writes a live credential into the access log, where it
 * outlives the session and the person who issued it. (nginx's default
 * `combined` format does this; so does almost every other proxy's.) The
 * header is the only place that value belongs.
 *
 * So: the image is fetched in JavaScript — where a header CAN be set —
 * and the resulting bytes are handed to the `<img>` as an object URL.
 * **This package does not know what a bearer token is and never will.**
 * All it knows is this function. You write the fetch; you own the
 * credential.
 *
 * CACHING IS NOT LOST, if you keep your URLs content-addressed (the
 * `?v=<version>` token docs/server-contract.md §4 already requires) and
 * send a long `Cache-Control` on those routes. `fetch()` honours the HTTP
 * cache, so a repeat render is served from disk, not the network.
 *
 * RETURN `null` FOR AN URL YOU DO NOT WANT TO HANDLE, and the component
 * renders a plain `<img src>` for it instead. That escape hatch is
 * load-bearing in a mixed app: a public image needs no credential, and
 * handling one through an authenticated fetch would be strictly worse.
 *
 * Not called at all for the package's own local previews (`blob:` and
 * `data:` URLs) — those are bytes this component itself created from a
 * picked file, and fetching them through a consumer's auth layer would
 * break the instant-preview path. That exclusion is structural, not a
 * convention you have to remember.
 */
export type LoadImage = (src: string) => Promise<Blob> | null;

/**
 * True for the URLs this component created itself from a local File. They
 * are already displayable and must never go through `loadImage` — see its
 * doc's last paragraph.
 */
function isLocalPreview(src: string): boolean {
  return src.startsWith('blob:') || src.startsWith('data:');
}

type ResolvedSrc =
  | { state: 'ready'; href: string }
  | { state: 'loading'; href: undefined }
  | { state: 'error'; href: undefined };

/**
 * Resolves an image URL into something an `<img>` can actually display.
 *
 * Exported separately from the component below because PhotoCropEditor
 * needs its own `<img>` (it carries a ref, an onLoad and a transform the
 * crop maths depends on) and only wants the URL resolved.
 */
export function useResolvedImageSrc(src: string | undefined, loadImage?: LoadImage): ResolvedSrc {
  const [resolved, setResolved] = useState<ResolvedSrc>(() =>
    // The common case — no `loadImage`, or a local preview — resolves
    // synchronously on the first render, so behaviour with no injection
    // is byte-for-byte a plain <img> with no loading flash.
    src && (!loadImage || isLocalPreview(src)) ? { state: 'ready', href: src } : { state: 'loading', href: undefined },
  );

  useEffect(() => {
    if (!src) {
      setResolved({ state: 'error', href: undefined });
      return;
    }
    if (!loadImage || isLocalPreview(src)) {
      setResolved({ state: 'ready', href: src });
      return;
    }

    const pending = loadImage(src);
    // `null` means "not mine, render it directly" — see LoadImage's doc.
    if (!pending) {
      setResolved({ state: 'ready', href: src });
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;
    setResolved({ state: 'loading', href: undefined });

    pending
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ state: 'ready', href: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setResolved({ state: 'error', href: undefined });
      });

    return () => {
      cancelled = true;
      // Revoking matters: a photo grid can hold dozens of these and every
      // object URL pins its blob in memory until it is released.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `loadImage` is a plain function prop. A consumer that rebuilds it
    // every render would otherwise re-fetch every thumbnail on every
    // render; the README says to memoize it, and this dep list is what
    // makes that instruction meaningful rather than decorative.
  }, [src, loadImage]);

  return resolved;
}

type LoadedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | undefined;
  loadImage?: LoadImage;
};

/**
 * Drop-in `<img>` that routes its bytes through `loadImage` when one is
 * supplied. With no `loadImage`, this renders exactly the `<img>` this
 * package rendered before the prop existed.
 */
export function LoadedImage({ src, loadImage, ...imgProps }: LoadedImageProps) {
  const { state, href } = useResolvedImageSrc(src, loadImage);
  // ALWAYS a real <img>, with `src` simply omitted until the bytes
  // arrive. Two reasons, both learned the hard way in the origin project:
  //  - an element that appears only once loaded makes the grid jump as
  //    each photo resolves, and layout shift is a real cost;
  //  - swapping the element type breaks every selector — tests and CSS
  //    alike — that reasonably expects an image to be an <img>.
  // An <img> with no `src` ATTRIBUTE renders empty, NOT as the browser's
  // broken-image icon (that needs an src that fails), which is the thing
  // this component exists to stop anyone seeing.
  // eslint-disable-next-line jsx-a11y/alt-text -- alt comes from imgProps; every caller passes one
  return <img {...imgProps} {...(state === 'ready' ? { src: href } : {})} data-pb-image-state={state} />;
}
