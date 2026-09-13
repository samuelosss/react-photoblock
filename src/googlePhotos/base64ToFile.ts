/**
 * Turns a base64-encoded byte string into a real `File`, so a picked
 * Google Photos item can be handed to PhotoUploader's own file-queue
 * exactly as if it had come from the OS file picker or a drag-drop. See
 * `GooglePhotosAdapter.importGooglePhotosSession` in src/types.ts for
 * where `dataBase64` comes from.
 */
export function base64ToFile(fileName: string, contentType: string, dataBase64: string): File {
  const byteString = atob(dataBase64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i += 1) {
    bytes[i] = byteString.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: contentType });
}
