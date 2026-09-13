import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGooglePhotosErrorMessage, useGooglePhotosPicker } from '../src/googlePhotos/useGooglePhotosPicker';
import { defaultLabels } from '../src/labels';
import type { GooglePhotosAdapter } from '../src/types';

function fakePopup() {
  return { closed: false, close: vi.fn() } as unknown as Window;
}

function fakeAdapter(overrides: Partial<GooglePhotosAdapter> = {}): GooglePhotosAdapter {
  return {
    startGooglePhotosPicker: vi.fn().mockResolvedValue({ url: 'https://accounts.example.com/o/oauth2/auth', state: 'state-1' }),
    pollGooglePhotosBridge: vi.fn(),
    pollGooglePhotosSession: vi.fn(),
    importGooglePhotosSession: vi.fn(),
    ...overrides,
  };
}

describe('useGooglePhotosPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(adapterOverrides: Partial<GooglePhotosAdapter> = {}) {
    const onPhotosReady = vi.fn();
    const adapter = fakeAdapter(adapterOverrides);
    const hook = renderHook(() => useGooglePhotosPicker({ adapter, onPhotosReady }));
    return { hook, onPhotosReady, adapter };
  }

  it('is disabled and inert with no adapter', () => {
    const onPhotosReady = vi.fn();
    const hook = renderHook(() => useGooglePhotosPicker({ adapter: undefined, onPhotosReady }));
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.phase).toBe('idle');
    // start() must be a safe no-op with no adapter — never throw.
    act(() => hook.result.current.start());
    expect(hook.result.current.phase).toBe('idle');
  });

  it('is enabled once an adapter is provided, and starts idle', () => {
    const { hook } = setup();
    expect(hook.result.current.enabled).toBe(true);
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.error).toBeNull();
  });

  it('opens the popup at the URL from start, and reports a blocked popup as an error', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { hook, adapter } = setup();

    await act(async () => {
      hook.result.current.start();
      await vi.runOnlyPendingTimersAsync();
    });

    expect(adapter.startGooglePhotosPicker).toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith('https://accounts.example.com/o/oauth2/auth', 'google-photos-picker', expect.any(String));
    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'popupBlocked' });
  });

  it('surfaces a failure from starting the picker as a startFailed error carrying the underlying message', async () => {
    const { hook } = setup({ startGooglePhotosPicker: vi.fn().mockRejectedValue(new Error('network down')) });

    await act(async () => {
      hook.result.current.start();
      await vi.runOnlyPendingTimersAsync();
    });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'startFailed', detail: 'network down' });
    expect(resolveGooglePhotosErrorMessage(hook.result.current.error!, defaultLabels.googlePhotos)).toBe('network down');
  });

  it('polls by state until ready, then moves to picking and polls the session until done and imports', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, onPhotosReady, adapter } = setup();
    const pollBridge = adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>;
    const pollSession = adapter.pollGooglePhotosSession as ReturnType<typeof vi.fn>;
    const importSession = adapter.importGooglePhotosSession as ReturnType<typeof vi.fn>;

    pollBridge
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValueOnce({ ready: true, sessionId: 'sess-1', pollIntervalMs: 1000, timeoutMs: 30 * 60 * 1000 });
    pollSession
      .mockResolvedValueOnce({ done: false, pollIntervalMs: 1000, expired: false })
      .mockResolvedValueOnce({ done: true, pollIntervalMs: 1000, expired: false });
    importSession.mockResolvedValue({
      photos: [{ fileName: 'a.webp', contentType: 'image/webp', dataBase64: btoa('fake-bytes') }],
    });

    act(() => hook.result.current.start());
    expect(hook.result.current.phase).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(pollBridge).toHaveBeenCalledWith('state-1');
    expect(hook.result.current.phase).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(hook.result.current.phase).toBe('picking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(pollSession).toHaveBeenCalledWith('sess-1');
    expect(hook.result.current.phase).toBe('picking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(importSession).toHaveBeenCalledWith('sess-1');
    expect(onPhotosReady).toHaveBeenCalledTimes(1);
    const files = onPhotosReady.mock.calls[0]![0] as File[];
    expect(files).toHaveLength(1);
    const [firstFile] = files;
    expect(firstFile).toBeInstanceOf(File);
    expect(firstFile!.name).toBe('a.webp');
    expect(firstFile!.type).toBe('image/webp');
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.importedCount).toBe(1);
  });

  it("treats a Cancel on the OAuth provider's consent screen (oauth_denied) as a silent reset, not an error", async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ready: true, error: 'oauth_denied' });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.error).toBeNull();
  });

  it('maps a known bridge error code to its label key', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ready: true, error: 'picker_session_failed' });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'pickerSessionFailed' });
    expect(resolveGooglePhotosErrorMessage(hook.result.current.error!, defaultLabels.googlePhotos)).toBe(
      defaultLabels.googlePhotos.errors.pickerSessionFailed,
    );
  });

  it("falls back to the 'generic' code for an unrecognized backend error code", async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ready: true,
      error: 'something_new_the_backend_added',
    });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'generic' });
  });

  it('gives up waiting for the OAuth round trip after its own local timeout', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: false });

    act(() => hook.result.current.start());
    for (let elapsed = 0; elapsed < 10 * 60 * 1000 + 3000; elapsed += 1500) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'bridgeTimeout' });
  });

  it('treats the picker session expiring as an error', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ready: true,
      sessionId: 'sess-1',
      pollIntervalMs: 1000,
      timeoutMs: 30 * 60 * 1000,
    });
    (adapter.pollGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({ done: false, pollIntervalMs: 1000, expired: true });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(hook.result.current.phase).toBe('picking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'sessionExpired' });
  });

  it('keeps polling even when popup.closed reports true — that signal is not trustworthy', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: false });

    act(() => hook.result.current.start());
    (popup as unknown as { closed: boolean }).closed = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(adapter.pollGooglePhotosBridge).toHaveBeenCalledWith('state-1');
    expect(hook.result.current.phase).toBe('connecting');
    expect(hook.result.current.error).toBeNull();
  });

  it('still completes normally when popup.closed lies during the session phase too', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const { hook, adapter, onPhotosReady } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: true,
      sessionId: 'sess-1',
      pollIntervalMs: 1000,
      timeoutMs: 30 * 60 * 1000,
    });
    (adapter.pollGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({ done: true, pollIntervalMs: 1000, expired: false });
    (adapter.importGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: [{ fileName: 'a.webp', contentType: 'image/webp', dataBase64: btoa('bytes') }],
    });

    act(() => hook.result.current.start());
    (popup as unknown as { closed: boolean }).closed = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(onPhotosReady).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe('idle');
  });

  it('cancel() stops the flow, closes the popup and returns to idle', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: false });

    await act(async () => {
      hook.result.current.start();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.phase).toBe('connecting');

    act(() => hook.result.current.cancel());
    expect(popup.close).toHaveBeenCalled();
    expect(hook.result.current.phase).toBe('idle');

    const callsAtCancel = (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect((adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtCancel);
  });

  it('reports an import failure as importFailed with the underlying detail', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ready: true,
      sessionId: 'sess-1',
      pollIntervalMs: 1000,
      timeoutMs: 30 * 60 * 1000,
    });
    (adapter.pollGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({ done: true, pollIntervalMs: 1000, expired: false });
    (adapter.importGooglePhotosSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No photos were picked in this session'));

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(hook.result.current.phase).toBe('error');
    expect(hook.result.current.error).toEqual({ code: 'importFailed', detail: 'No photos were picked in this session' });
    expect(resolveGooglePhotosErrorMessage(hook.result.current.error!, defaultLabels.googlePhotos)).toBe(
      'Importing photos failed: No photos were picked in this session',
    );
  });

  it('start() is a no-op while a flow is already in progress', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();

    act(() => hook.result.current.start());
    expect(adapter.startGooglePhotosPicker).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.start());
    // Still 'connecting' (bridge poll not yet resolved) — a second start()
    // call must not re-trigger the whole OAuth dance.
    expect(adapter.startGooglePhotosPicker).toHaveBeenCalledTimes(1);
  });

  it('leaves an importedCount after a successful import, cleared when a new run starts', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakePopup());
    const { hook, adapter } = setup();
    (adapter.pollGooglePhotosBridge as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: true,
      sessionId: 'sess-1',
      pollIntervalMs: 1000,
      timeoutMs: 30 * 60 * 1000,
    });
    (adapter.pollGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({ done: true, pollIntervalMs: 1000, expired: false });
    (adapter.importGooglePhotosSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: [
        { fileName: 'a.webp', contentType: 'image/webp', dataBase64: btoa('bytes') },
        { fileName: 'b.webp', contentType: 'image/webp', dataBase64: btoa('bytes') },
        { fileName: 'c.webp', contentType: 'image/webp', dataBase64: btoa('bytes') },
      ],
    });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.importedCount).toBe(3);
    expect(defaultLabels.googlePhotos.importedNotice(3)).toBe('3 photos imported — you can close the Google Photos window.');
    expect(defaultLabels.googlePhotos.importedNotice(1)).toBe('1 photo imported — you can close the Google Photos window.');

    act(() => hook.result.current.start());
    expect(hook.result.current.importedCount).toBeNull();
  });

  it('dismissError resets an error back to idle', async () => {
    const { hook } = setup({ startGooglePhotosPicker: vi.fn().mockRejectedValue(new Error('boom')) });

    act(() => hook.result.current.start());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.phase).toBe('error');

    act(() => hook.result.current.dismissError());
    expect(hook.result.current.phase).toBe('idle');
    expect(hook.result.current.error).toBeNull();
  });
});
