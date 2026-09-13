import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhotoUploader } from '../src/components/PhotoUploader';
import type { PhotoApi, UploadResult, ImageUrlsResult, GooglePhotosAdapter } from '../src/types';

function fakeApi(overrides: Partial<PhotoApi> = {}): PhotoApi {
  return {
    uploadPhoto: vi.fn(async (_entityId: string, file: File): Promise<UploadResult> => ({
      fileName: file.name,
      status: 'success',
      imageUrls: [`/images/${file.name}`],
    })),
    deleteImage: vi.fn(async () => {}),
    reorderImages: vi.fn(async (_entityId: string, ids: string[]): Promise<ImageUrlsResult> => ({
      imageUrls: ids.map((id) => `/images/${id}`),
    })),
    replaceImage: vi.fn(async (_entityId: string, imageId: string): Promise<ImageUrlsResult> => ({
      imageUrls: [`/images/${imageId}?v=2`],
    })),
    ...overrides,
  };
}

function makeFile(name: string) {
  return new File(['x'], name, { type: 'image/png' });
}

describe('PhotoUploader', () => {
  it('renders existing photos and lets them be deleted with confirmation', async () => {
    const api = fakeApi();
    const onImageUrlsChange = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PhotoUploader entityId="entity-1" imageUrls={['/images/1', '/images/2']} onImageUrlsChange={onImageUrlsChange} api={api} />,
    );

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' });
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() => expect(api.deleteImage).toHaveBeenCalledWith('entity-1', '1'));
    expect(onImageUrlsChange).toHaveBeenCalledWith(['/images/2']);
  });

  it('does not delete when the confirm dialog is dismissed', () => {
    const api = fakeApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<PhotoUploader entityId="entity-1" imageUrls={['/images/1']} onImageUrlsChange={vi.fn()} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }));

    expect(api.deleteImage).not.toHaveBeenCalled();
  });

  it('queues a picked file locally (no upload) when entityId is null, then uploads it automatically once entityId becomes real', async () => {
    const api = fakeApi();
    const onImageUrlsChange = vi.fn();

    const { rerender } = render(
      <PhotoUploader entityId={null} imageUrls={[]} onImageUrlsChange={onImageUrlsChange} api={api} />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = makeFile('sunset.png');
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText('sunset.png')).toBeInTheDocument();
    expect(screen.getByText('Waiting to be saved')).toBeInTheDocument();
    expect(api.uploadPhoto).not.toHaveBeenCalled();

    rerender(<PhotoUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={onImageUrlsChange} api={api} />);

    await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledWith('entity-1', file, expect.any(Function)));
    await waitFor(() => expect(onImageUrlsChange).toHaveBeenCalledWith(['/images/sunset.png']));
  });

  it('uploads immediately when entityId is already present', async () => {
    const api = fakeApi();
    const onImageUrlsChange = vi.fn();
    render(<PhotoUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={onImageUrlsChange} api={api} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = makeFile('a.png');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledWith('entity-1', file, expect.any(Function)));
  });

  it('reports upload failure inline and allows a retry', async () => {
    const api = fakeApi({
      uploadPhoto: vi
        .fn()
        .mockResolvedValueOnce({ fileName: 'a.png', status: 'error', error: 'Too large' })
        .mockResolvedValueOnce({ fileName: 'a.png', status: 'success', imageUrls: ['/images/a.png'] }),
    });
    const onImageUrlsChange = vi.fn();
    render(<PhotoUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={onImageUrlsChange} api={api} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('a.png')] } });

    await waitFor(() => expect(screen.getByText('Too large')).toBeInTheDocument());
    expect(screen.getByText('Error ✗')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onImageUrlsChange).toHaveBeenCalledWith(['/images/a.png']));
    expect(api.uploadPhoto).toHaveBeenCalledTimes(2);
  });

  it('moves a photo with the keyboard move-right button and calls reorderImages with the whole new id order', async () => {
    const api = fakeApi();
    const onImageUrlsChange = vi.fn();
    render(
      <PhotoUploader entityId="entity-1" imageUrls={['/images/1', '/images/2', '/images/3']} onImageUrlsChange={onImageUrlsChange} api={api} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move photo 1 of 3 right' }));

    await waitFor(() => expect(api.reorderImages).toHaveBeenCalledWith('entity-1', ['2', '1', '3']));
    expect(onImageUrlsChange).toHaveBeenCalledWith(['/images/2', '/images/1', '/images/3']);
  });

  it('reverts the order and alerts if a reorder request fails', async () => {
    const api = fakeApi({ reorderImages: vi.fn().mockRejectedValue(new Error('offline')) });
    const onImageUrlsChange = vi.fn();
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <PhotoUploader entityId="entity-1" imageUrls={['/images/1', '/images/2']} onImageUrlsChange={onImageUrlsChange} api={api} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move photo 1 of 2 right' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('offline'));
    // Optimistic update, then reverted back to the original order.
    expect(onImageUrlsChange).toHaveBeenLastCalledWith(['/images/1', '/images/2']);
  });

  it('opens the crop editor for an existing photo and replaces it in place on save', async () => {
    const api = fakeApi();
    const onImageUrlsChange = vi.fn();
    render(<PhotoUploader entityId="entity-1" imageUrls={['/images/7']} onImageUrlsChange={onImageUrlsChange} api={api} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit photo 1 of 1' }));
    expect(screen.getByRole('dialog', { name: 'Edit photo' })).toBeInTheDocument();

    // Force an actual "change" so Save calls onSave with a Blob — stub the
    // canvas pipeline exactly like PhotoCropEditor's own test suite does.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb) {
      cb(new Blob(['bytes'], { type: 'image/webp' }));
    });

    const img = within(screen.getByRole('dialog')).getByAltText('') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(img);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right 90°' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    await waitFor(() => expect(api.replaceImage).toHaveBeenCalledWith('entity-1', '7', expect.any(Blob)));
    await waitFor(() => expect(onImageUrlsChange).toHaveBeenCalledWith(['/images/7?v=2']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has no Google Photos button when no adapter is provided', () => {
    render(<PhotoUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={vi.fn()} api={fakeApi()} />);
    expect(screen.queryByRole('button', { name: 'Choose from Google Photos' })).not.toBeInTheDocument();
  });

  it('shows the Google Photos button once an adapter is provided', () => {
    const googlePhotos: GooglePhotosAdapter = {
      startGooglePhotosPicker: vi.fn(),
      pollGooglePhotosBridge: vi.fn(),
      pollGooglePhotosSession: vi.fn(),
      importGooglePhotosSession: vi.fn(),
    };
    render(<PhotoUploader entityId="entity-1" imageUrls={[]} onImageUrlsChange={vi.fn()} api={fakeApi()} googlePhotos={googlePhotos} />);
    expect(screen.getByRole('button', { name: 'Choose from Google Photos' })).toBeInTheDocument();
  });

  it('supports the Czech labels preset end to end, including the dropzone and delete confirmation', async () => {
    const { csLabels } = await import('../src/labels');
    const api = fakeApi();
    render(<PhotoUploader entityId="entity-1" imageUrls={['/images/1']} onImageUrlsChange={vi.fn()} api={api} labels={csLabels} />);

    expect(screen.getByText('+ Přidat fotky nebo je sem přetáhnout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Smazat fotku' })).toBeInTheDocument();
  });

  it('supports overriding a single label without affecting the rest', () => {
    render(
      <PhotoUploader
        entityId="entity-1"
        imageUrls={[]}
        onImageUrlsChange={vi.fn()}
        api={fakeApi()}
        labels={{ uploader: { dropzoneIdle: 'Add some photos!' } }}
      />,
    );
    expect(screen.getByText('Add some photos!')).toBeInTheDocument();
  });

  it('announces the picked-file count region for screen readers as files are queued', () => {
    const api = fakeApi();
    render(<PhotoUploader entityId={null} imageUrls={[]} onImageUrlsChange={vi.fn()} api={api} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('a.png'), makeFile('b.png')] } });

    const region = screen.getByLabelText('Photos: 2 waiting to be saved, 0 uploaded, 0 failed');
    expect(within(region).getAllByText('Waiting to be saved')).toHaveLength(2);
  });
});
