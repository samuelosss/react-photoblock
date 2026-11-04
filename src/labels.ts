/**
 * Every visible string and every aria-label MediaUploader, PhotoCropEditor
 * and the Google Photos picker can render, as one typed, overridable
 * structure. Nothing in src/components or src/googlePhotos hardcodes UI
 * text — it all comes from a `labels` prop, defaulted to `defaultLabels`
 * (English) below. `csLabels` is a complete Czech translation, the one
 * this package's components originally shipped with in production, kept
 * as a ready-made preset since it already exists and is proven.
 */

import { formatMegabytes } from './formatMedia';

export interface MediaUploaderLabels {
  /** Dropzone label while nothing is being dragged over it. */
  dropzoneIdle: string;
  /** Dropzone label while a drag is over it. */
  dropzoneActive: string;
  /** Hint paragraph under the dropzone. `entitySaved` is false before the
   *  owning entity has ever been saved (see MediaUploaderProps.entityId) —
   *  the default text appends a sentence explaining photos will upload
   *  automatically once it is. */
  hint: (entitySaved: boolean) => string;
  /** aria-label on an uploaded photo's delete button. */
  removeExisting: string;
  /** aria-label on an uploaded photo's edit (crop) button. 1-based index. */
  editExisting: (index: number, total: number) => string;
  /** aria-label on the keyboard move-left button. 1-based index. */
  moveLeft: (index: number, total: number) => string;
  /** aria-label on the keyboard move-right button. 1-based index. */
  moveRight: (index: number, total: number) => string;
  /** aria-label on the upload-queue's live region. */
  queueRegionLabel: (queuedCount: number, uploadedCount: number, failedCount: number) => string;
  queueStatusQueued: string;
  queueStatusUploading: (percent: number) => string;
  queueStatusSuccess: string;
  queueStatusError: string;
  /** aria-label removing a not-yet-uploaded queue item. */
  removeQueued: (fileName: string) => string;
  /** aria-label editing a queued item. */
  editQueued: (fileName: string) => string;
  /** title shown on the (disabled) edit button while a queued item is mid-upload. */
  editQueuedUploadingTitle: string;
  editButtonText: string;
  retryButtonText: string;
  /** Visible text on the "give up on this failed upload" button (distinct
   *  from `removeQueued`, which is only an aria-label on the plain "×"
   *  button shown for still-queued, not-yet-attempted items). */
  cancelButtonText: string;
  /** window.confirm() text before deleting an uploaded photo. */
  confirmDelete: string;
  /** window.alert() text if deletion fails. */
  deleteFailed: string;
  /** window.alert() text if a reorder request fails. */
  reorderFailedAlert: string;
  /** Screen-reader announcement when a reorder request fails and is reverted. */
  reorderFailedAnnouncement: string;
  /** Screen-reader announcement after a successful reorder of a
   *  photo-only grid. All 1-based. */
  moveAnnouncement: (fromPosition: number, toPosition: number, total: number) => string;
  /** The same announcement for a grid that also holds videos, where
   *  "photo" would be the wrong noun. Separate rather than a parameter on
   *  `moveAnnouncement` so a consumer with no video support never has to
   *  think about it, and its wording stays byte-for-byte unchanged. */
  mediaMoveAnnouncement: (fromPosition: number, toPosition: number, total: number) => string;
  /** window.alert() text if saving a crop fails. */
  cropSaveFailedAlert: string;

  // -- Video. Every string below is unreachable unless a `VideoApi` is
  // injected (see MediaUploaderProps.video), so a photo-only consumer can
  // ignore this entire block.

  /** Video dropzone label while nothing is being dragged over it. */
  videoDropzoneIdle: string;
  /** Video dropzone label while a drag is over it. */
  videoDropzoneActive: string;
  /** Hint under the video dropzone. Receives the resolved limits so the
   *  copy can state them — see `VideoLimits`, which a consumer must set
   *  to match its own server. */
  videoHint: (entitySaved: boolean, maxBytes: number, maxDurationSeconds: number) => string;
  /** aria-label on a video tile's keyboard move-left button. 1-based. */
  moveLeftVideo: (index: number, total: number) => string;
  /** aria-label on a video tile's keyboard move-right button. 1-based. */
  moveRightVideo: (index: number, total: number) => string;
  /** aria-label on a video tile's delete button. */
  removeExistingVideo: string;
  /** window.confirm() text before deleting a video. */
  confirmDeleteVideo: string;
  /** window.alert() text if deleting a video fails. */
  deleteVideoFailed: string;
  /** aria-label on the video queue panel — the non-grid list holding
   *  not-yet-uploaded files and server rows that are still transcoding or
   *  have failed. */
  videoQueueRegionLabel: string;
  /** Name shown for a server-tracked row. A row that reached the server
   *  has an id, not a filename — the original name is not part of the
   *  contract (`VideoItem` carries no such field), so there is nothing
   *  truer available to show. */
  videoQueueRowName: string;
  /** Reading the file's duration client-side, right after picking. */
  videoStatusEstimating: string;
  /** The estimate came back over the soft threshold; waiting on an
   *  explicit "upload anyway". */
  videoStatusAwaitingConfirmation: string;
  videoStatusQueued: string;
  videoStatusUploading: (percent: number) => string;
  /** The server accepted it and is transcoding. */
  videoStatusProcessing: string;
  videoStatusError: string;
  /** The soft BEFORE-upload warning: this clip is estimated to land over
   *  `sizeWarnBytes` once transcoded. Never blocks. */
  videoSizeConfirmPrompt: (estimatedBytes: number) => string;
  /** Visible text on the "upload it anyway" button for that warning. */
  videoUploadAnywayText: string;
  /** aria-label removing a not-yet-uploaded video from the queue. */
  removeQueuedVideo: (fileName: string) => string;
  /** Visible text on the "delete this failed video row" button. */
  videoDeleteButtonText: string;
  /** Rejected client-side before upload: over `maxBytes`. */
  videoTooLarge: (bytes: number, maxBytes: number) => string;
  /** Rejected client-side before upload: over `maxDurationSeconds`. */
  videoTooLong: (durationSeconds: number, maxDurationSeconds: number) => string;
  /** Fallback when `uploadVideo` reports an error with no message. */
  videoUploadFailed: string;
  /** window.alert() text when a failed row's retry is not possible
   *  because this browser tab no longer holds the original file — see
   *  MediaUploader's `uploadedFilesRef`. */
  videoRetryUnavailable: string;
  /** The dismissible AFTER-transcode note on a ready video tile whose
   *  stored size is over `sizeWarnBytes`. */
  videoSizeWarning: (bytes: number) => string;
  /** Visible text on that note's dismiss button. */
  videoSizeWarningDismiss: string;
}

export interface PhotoCropEditorLabels {
  /** aria-label on the modal dialog. */
  dialogLabel: string;
  hint: string;
  canvasUnsupported: string;
  saveFailed: string;
  rotateLeftAria: string;
  rotateLeftText: string;
  rotateRightAria: string;
  rotateRightText: string;
  cancel: string;
  save: string;
  saving: string;
  /** Shown instead of `save` when nothing has changed yet — clicking it
   *  is a plain close, not a save. */
  close: string;
}

export interface GooglePhotosErrorLabels {
  googleNotConfigured: string;
  invalidState: string;
  missingCode: string;
  oauthFailed: string;
  pickerSessionFailed: string;
  sessionExpired: string;
  bridgeTimeout: string;
  popupBlocked: string;
  /**
   * A video was picked but the owning entity has never been saved, so
   * there is no parent for the server to attach the new video row to.
   * Unlike the per-item `videoErrors` below, this rejects the WHOLE
   * import — nothing at all is imported. See
   * docs/google-photos-setup.md's "Importing video".
   */
  videoNeedsSavedParent: string;
  /** Fallback for any error code the adapter reports that isn't one of
   *  the fixed ones above — keeps an unrecognized future backend error
   *  code from crashing or showing nothing. */
  generic: string;
  /** `detail` is the underlying Error's message, when the failure came
   *  from a thrown exception rather than a known error code. */
  startFailed: (detail?: string) => string;
  pollFailed: (detail?: string) => string;
  importFailed: (detail?: string) => string;
}

/**
 * Display text for the PER-ITEM video import failures a successful import
 * can still report (`GooglePhotosImportResult.videoErrors`).
 *
 * A CLOSED SET, on purpose, and typed as a full record so adding a code
 * without its text fails `tsc`. The origin project learned this the hard
 * way twice over: its import route first typed this field as a bare
 * `string` and passed a shared pipeline's own codes straight through, so
 * codes that knew nothing about Google Photos reached the user as
 * untranslated English — the exact bug the field existed to fix.
 *
 * Anything outside this set falls back to the server's own `message` (see
 * `videoErrorLine`). That is the honest escape hatch for a backend code
 * this package has not met yet, never a substitute for adding one.
 */
export interface GooglePhotosVideoErrorLabels {
  /** Google itself has not finished processing the item — retriable. */
  videoNotReady: string;
  videoTooLarge: string;
  videoDownloadFailed: string;
  videoProcessingFailed: string;
  videoTooLong: string;
  /** The server's transcode queue is full — retriable. */
  videoQueueFull: string;
}

export interface GooglePhotosLabels {
  pickButton: string;
  /** Replaces `pickButton` when a `VideoApi` is injected, because the
   *  same picker then handles both. Its own label matters: in the origin
   *  project the button sat under the VIDEO dropzone and read as
   *  photo-only, so the owner picked a video through what they reasonably
   *  took to be the video control and got a raw API error. */
  pickButtonWithVideo: string;
  connecting: string;
  picking: string;
  importing: string;
  cancel: string;
  /** Shown after a successful import — the popup usually can't be closed
   *  programmatically by then (see docs/google-photos-setup.md), so this
   *  is the one thing the user still needs telling. Counts arrive
   *  separately because a single import can land photos, land videos and
   *  fail on other videos all at once. */
  importedNotice: (counts: { photos: number; videos: number; failedVideos: number }) => string;
  /** Renders one `videoErrors` entry. `message` is already resolved: the
   *  text for a known code, or the server's own message for one this
   *  package does not know. */
  videoErrorLine: (fileName: string, message: string) => string;
  errors: GooglePhotosErrorLabels;
  videoErrors: GooglePhotosVideoErrorLabels;
}

export interface MediaBlockLabels {
  uploader: MediaUploaderLabels;
  cropEditor: PhotoCropEditorLabels;
  googlePhotos: GooglePhotosLabels;
}

const uploaderHintBase =
  'Choose photos from your library, or drag them in. Each photo max 15 MB, up to 10 at a time. ' +
  'Click a photo to edit it (crop, rotate).';

export const defaultLabels: MediaBlockLabels = {
  uploader: {
    dropzoneIdle: '+ Add photos, or drag them here',
    dropzoneActive: 'Drop photos here',
    hint: (entitySaved) =>
      entitySaved ? uploaderHintBase : `${uploaderHintBase} They upload automatically as soon as you save for the first time.`,
    removeExisting: 'Delete photo',
    editExisting: (index, total) => `Edit photo ${index} of ${total}`,
    moveLeft: (index, total) => `Move photo ${index} of ${total} left`,
    moveRight: (index, total) => `Move photo ${index} of ${total} right`,
    queueRegionLabel: (queuedCount, uploadedCount, failedCount) =>
      `Photos: ${queuedCount} waiting to be saved, ${uploadedCount} uploaded, ${failedCount} failed`,
    queueStatusQueued: 'Waiting to be saved',
    queueStatusUploading: (percent) => `${percent}%`,
    queueStatusSuccess: 'Uploaded ✓',
    queueStatusError: 'Error ✗',
    removeQueued: (fileName) => `Remove ${fileName} from the queue`,
    editQueued: (fileName) => `Edit ${fileName}`,
    editQueuedUploadingTitle: 'This photo is uploading, please wait.',
    editButtonText: 'Edit',
    retryButtonText: 'Retry',
    cancelButtonText: 'Cancel',
    confirmDelete: 'Delete this photo?',
    deleteFailed: 'Deleting the photo failed.',
    reorderFailedAlert: 'Reordering failed.',
    reorderFailedAnnouncement: 'Reordering failed, the previous order was restored.',
    moveAnnouncement: (fromPosition, toPosition, total) =>
      `Photo moved from position ${fromPosition} to position ${toPosition} of ${total}.`,
    mediaMoveAnnouncement: (fromPosition, toPosition, total) =>
      `Item moved from position ${fromPosition} to position ${toPosition} of ${total}.`,
    cropSaveFailedAlert: 'Editing the photo failed.',

    videoDropzoneIdle: '+ Add a video, or drag it here',
    videoDropzoneActive: 'Drop the video here',
    videoHint: (entitySaved, maxBytes, maxDurationSeconds) =>
      `Video up to ${formatMegabytes(maxBytes)} and ${Math.round(maxDurationSeconds / 60)} minutes. ` +
      'After uploading it is processed in the background — that can take a few minutes, and you can keep editing meanwhile.' +
      (entitySaved ? '' : ' It uploads automatically as soon as you save for the first time.'),
    moveLeftVideo: (index, total) => `Move video ${index} of ${total} left`,
    moveRightVideo: (index, total) => `Move video ${index} of ${total} right`,
    removeExistingVideo: 'Delete video',
    confirmDeleteVideo: 'Delete this video?',
    deleteVideoFailed: 'Deleting the video failed.',
    videoQueueRegionLabel: 'Videos being processed',
    videoQueueRowName: 'Video',
    videoStatusEstimating: 'Reading length…',
    videoStatusAwaitingConfirmation: 'Waiting for confirmation',
    videoStatusQueued: 'Waiting to be saved',
    videoStatusUploading: (percent) => `${percent}%`,
    videoStatusProcessing: 'Processing…',
    videoStatusError: 'Error ✗',
    videoSizeConfirmPrompt: (estimatedBytes) =>
      `Estimated size after conversion: ~${formatMegabytes(estimatedBytes)}. That may be a lot of data for a visitor on mobile. Upload anyway?`,
    videoUploadAnywayText: 'Upload anyway',
    removeQueuedVideo: (fileName) => `Remove ${fileName} from the queue`,
    videoDeleteButtonText: 'Delete',
    videoTooLarge: (bytes, maxBytes) =>
      `The file is ${formatMegabytes(bytes)}, over the ${formatMegabytes(maxBytes)} limit.`,
    videoTooLong: (durationSeconds, maxDurationSeconds) =>
      `The video is ${Math.ceil(durationSeconds / 60)} min long; the limit is ${Math.round(maxDurationSeconds / 60)} min.`,
    videoUploadFailed: 'Uploading the video failed.',
    videoRetryUnavailable:
      'The video could not be processed. Please upload it again — this page no longer has the original file.',
    videoSizeWarning: (bytes) => `${formatMegabytes(bytes)} — a lot of data for a visitor on mobile.`,
    videoSizeWarningDismiss: 'Hide',
  },
  cropEditor: {
    dialogLabel: 'Edit photo',
    hint: 'Drag a corner to crop, drag the middle to move it. Nothing is saved if nothing changed.',
    canvasUnsupported: 'This browser does not support photo editing (canvas).',
    saveFailed: 'Saving the preview failed, please try again.',
    rotateLeftAria: 'Rotate left 90°',
    rotateLeftText: '↺ Rotate',
    rotateRightAria: 'Rotate right 90°',
    rotateRightText: '↻ Rotate',
    cancel: 'Cancel',
    save: 'Save edit',
    saving: 'Saving…',
    close: 'Close',
  },
  googlePhotos: {
    pickButton: 'Choose from Google Photos',
    pickButtonWithVideo: 'Choose from Google Photos (photos and video)',
    connecting: 'Connecting…',
    picking: 'Waiting for you to pick in the popup…',
    importing: 'Importing selected items…',
    cancel: 'Cancel',
    importedNotice: ({ photos, videos, failedVideos }) => {
      const parts: string[] = [];
      if (photos > 0) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`);
      if (videos > 0) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
      let text = parts.length > 0 ? `${parts.join(' and ')} imported` : '';
      if (failedVideos > 0) {
        const failed = `${failedVideos} video${failedVideos === 1 ? '' : 's'} could not be imported`;
        text = text ? `${text}, ${failed}` : failed;
      }
      return `${text} — you can close the Google Photos window.`;
    },
    videoErrorLine: (fileName, message) => `${fileName}: ${message}`,
    errors: {
      googleNotConfigured: 'Google Photos picking is not set up yet.',
      invalidState: 'Verification failed, please try again.',
      missingCode: 'Signing in to Google failed, please try again.',
      oauthFailed: 'Signing in to Google failed, please try again.',
      pickerSessionFailed: 'Could not open the photo picker, please try again.',
      sessionExpired: 'Time to pick photos ran out, please try again.',
      bridgeTimeout: 'Signing in to Google took too long, please try again.',
      popupBlocked: 'Your browser blocked the popup. Allow popups for this page and try again.',
      videoNeedsSavedParent:
        'A video from Google Photos can only be added after the first save. Save, then pick the video again.',
      generic: 'Something went wrong, please try again.',
      startFailed: (detail) => detail ?? 'Could not start the photo picker.',
      pollFailed: (detail) => detail ?? 'Picking photos failed.',
      importFailed: (detail) => (detail ? `Importing failed: ${detail}` : 'Importing failed.'),
    },
    videoErrors: {
      videoNotReady: 'Google Photos has not finished processing this video yet — try again in a moment.',
      videoTooLarge: 'The video is larger than the allowed limit.',
      videoDownloadFailed: 'The video could not be downloaded from Google Photos.',
      videoProcessingFailed: 'Processing the video failed.',
      videoTooLong: 'The video is longer than the allowed limit.',
      videoQueueFull: 'The video processing queue is full — try again in a few minutes.',
    },
  },
};

/**
 * Czech preset — a verbatim port of the strings this package's components
 * shipped with in their origin production use, kept as a ready-made
 * alternative to typing out a full translation. Not the default: this is
 * a general-purpose package, so English is the neutral starting point,
 * and any locale (including this one) is opted into via the `labels`
 * prop, e.g. `<MediaUploader labels={csLabels} ... />`.
 */
const csUploaderHintBase =
  'Vyberte fotky z knihovny telefonu, nebo je přetáhněte myší. Každá fotka max. 15 MB, ' +
  'najednou lze vybrat až 10 fotek. Kliknutím na fotku ji můžete upravit (výřez, otočení).';

function csImportedPhotosLabel(count: number): string {
  if (count === 1) return 'Fotka je nahraná';
  if (count >= 2 && count <= 4) return `${count} fotky jsou nahrané`;
  return `${count} fotek je nahraných`;
}

/** Same three-plural-form treatment as csImportedPhotosLabel, for videos. */
function csImportedVideosLabel(count: number): string {
  if (count === 1) return '1 video je nahrané';
  if (count >= 2 && count <= 4) return `${count} videa jsou nahraná`;
  return `${count} videí je nahraných`;
}

export const csLabels: MediaBlockLabels = {
  uploader: {
    dropzoneIdle: '+ Přidat fotky nebo je sem přetáhnout',
    dropzoneActive: 'Pustit fotky sem',
    hint: (entitySaved) =>
      entitySaved ? csUploaderHintBase : `${csUploaderHintBase} Nahrají se automaticky hned po prvním uložení.`,
    removeExisting: 'Smazat fotku',
    editExisting: (index, total) => `Upravit fotku ${index} z ${total}`,
    moveLeft: (index, total) => `Posunout fotku ${index} z ${total} doleva`,
    moveRight: (index, total) => `Posunout fotku ${index} z ${total} doprava`,
    queueRegionLabel: (queuedCount, uploadedCount, failedCount) =>
      `Fotky: ${queuedCount} čeká na uložení, ${uploadedCount} nahráno, ${failedCount} se nezdařilo`,
    queueStatusQueued: 'Čeká na uložení',
    queueStatusUploading: (percent) => `${percent}%`,
    queueStatusSuccess: 'Nahráno ✓',
    queueStatusError: 'Chyba ✗',
    removeQueued: (fileName) => `Odebrat fotku ${fileName} z fronty`,
    editQueued: (fileName) => `Upravit fotku ${fileName}`,
    editQueuedUploadingTitle: 'Fotka se právě nahrává, počkejte prosím.',
    editButtonText: 'Upravit',
    retryButtonText: 'Zkusit znovu',
    cancelButtonText: 'Zrušit',
    confirmDelete: 'Opravdu smazat tuto fotku?',
    deleteFailed: 'Smazání fotky se nezdařilo.',
    reorderFailedAlert: 'Změna pořadí se nezdařila.',
    reorderFailedAnnouncement: 'Změna pořadí se nezdařila, pořadí bylo vráceno zpět.',
    moveAnnouncement: (fromPosition, toPosition, total) =>
      `Fotka z pozice ${fromPosition} přesunuta na pozici ${toPosition} z ${total}.`,
    mediaMoveAnnouncement: (fromPosition, toPosition, total) =>
      `Položka z pozice ${fromPosition} přesunuta na pozici ${toPosition} z ${total}.`,
    cropSaveFailedAlert: 'Úprava fotky se nezdařila.',

    videoDropzoneIdle: '+ Přidat video nebo je sem přetáhnout',
    videoDropzoneActive: 'Pustit video sem',
    videoHint: (entitySaved, maxBytes, maxDurationSeconds) =>
      `Video max. ${formatMegabytes(maxBytes)} a ${Math.round(maxDurationSeconds / 60)} minut. ` +
      'Po nahrání se video zpracovává na pozadí — může to trvat i několik minut, mezitím můžete pokračovat v úpravách.' +
      (entitySaved ? '' : ' Nahraje se automaticky hned po prvním uložení.'),
    moveLeftVideo: (index, total) => `Posunout video ${index} z ${total} doleva`,
    moveRightVideo: (index, total) => `Posunout video ${index} z ${total} doprava`,
    removeExistingVideo: 'Smazat video',
    confirmDeleteVideo: 'Opravdu smazat toto video?',
    deleteVideoFailed: 'Smazání videa se nezdařilo.',
    videoQueueRegionLabel: 'Videa ve zpracování',
    videoQueueRowName: 'Video',
    videoStatusEstimating: 'Zjišťuji délku…',
    videoStatusAwaitingConfirmation: 'Čeká na potvrzení',
    videoStatusQueued: 'Čeká na uložení',
    videoStatusUploading: (percent) => `${percent}%`,
    videoStatusProcessing: 'Zpracovává se…',
    videoStatusError: 'Chyba ✗',
    videoSizeConfirmPrompt: (estimatedBytes) =>
      `Odhad po převodu: ~${formatMegabytes(estimatedBytes)}. To může být hodně dat pro návštěvníka na mobilu. Pokračovat i tak?`,
    videoUploadAnywayText: 'Nahrát přesto',
    removeQueuedVideo: (fileName) => `Odebrat video ${fileName} z fronty`,
    videoDeleteButtonText: 'Smazat',
    videoTooLarge: (bytes, maxBytes) =>
      `Soubor má ${formatMegabytes(bytes)}, což je nad limitem ${formatMegabytes(maxBytes)}.`,
    videoTooLong: (durationSeconds, maxDurationSeconds) =>
      `Video je dlouhé ${Math.ceil(durationSeconds / 60)} min, limit je ${Math.round(maxDurationSeconds / 60)} min.`,
    videoUploadFailed: 'Nahrávání videa se nezdařilo.',
    videoRetryUnavailable:
      'Video se nepodařilo zpracovat. Nahrajte je prosím znovu — původní soubor už tato stránka nemá k dispozici.',
    videoSizeWarning: (bytes) => `${formatMegabytes(bytes)} — hodně dat pro návštěvníka na mobilu.`,
    videoSizeWarningDismiss: 'Skrýt',
  },
  cropEditor: {
    dialogLabel: 'Upravit fotku',
    hint: 'Přetažením rohů oříznete fotku, přetažením středu ji posunete. Beze změny se nic neuloží.',
    canvasUnsupported: 'Tento prohlížeč nepodporuje úpravu fotek (canvas).',
    saveFailed: 'Uložení náhledu se nezdařilo, zkuste to prosím znovu.',
    rotateLeftAria: 'Otočit doleva o 90°',
    rotateLeftText: '↺ Otočit',
    rotateRightAria: 'Otočit doprava o 90°',
    rotateRightText: '↻ Otočit',
    cancel: 'Zrušit',
    save: 'Uložit úpravu',
    saving: 'Ukládám…',
    close: 'Zavřít',
  },
  googlePhotos: {
    pickButton: 'Vybrat fotky z Google Photos',
    pickButtonWithVideo: 'Vybrat z Google Photos (fotky i video)',
    connecting: 'Připojování…',
    picking: 'Čeká se na výběr ve vyskakovacím okně…',
    importing: 'Importuji vybrané položky…',
    cancel: 'Zrušit',
    importedNotice: ({ photos, videos, failedVideos }) => {
      const parts: string[] = [];
      if (photos > 0) parts.push(csImportedPhotosLabel(photos));
      if (videos > 0) parts.push(csImportedVideosLabel(videos));
      let text = parts.join(' a ');
      if (failedVideos > 0) {
        const failed =
          failedVideos === 1
            ? '1 video se nepodařilo naimportovat'
            : `${failedVideos} videí se nepodařilo naimportovat`;
        text = text ? `${text}, ${failed}` : failed;
      }
      return `${text} — okno Google Photos můžete zavřít.`;
    },
    videoErrorLine: (fileName, message) => `${fileName}: ${message}`,
    errors: {
      googleNotConfigured: 'Výběr z Google Photos zatím není nastaven.',
      invalidState: 'Ověření se nezdařilo, zkuste to prosím znovu.',
      missingCode: 'Přihlášení ke Google se nezdařilo, zkuste to prosím znovu.',
      oauthFailed: 'Přihlášení ke Google se nezdařilo, zkuste to prosím znovu.',
      pickerSessionFailed: 'Nepodařilo se otevřít výběr fotek, zkuste to prosím znovu.',
      sessionExpired: 'Čas na výběr fotek vypršel, zkuste to prosím znovu.',
      bridgeTimeout: 'Přihlášení ke Google trvalo příliš dlouho, zkuste to prosím znovu.',
      popupBlocked: 'Prohlížeč zablokoval vyskakovací okno. Povolte vyskakovací okna pro tuto stránku a zkuste to znovu.',
      videoNeedsSavedParent:
        'Video z Google Photos jde přidat až po prvním uložení. Uložte příspěvek a vyberte video znovu.',
      generic: 'Něco se nepovedlo, zkuste to prosím znovu.',
      startFailed: (detail) => detail ?? 'Nepodařilo se spustit výběr fotek.',
      pollFailed: (detail) => detail ?? 'Výběr fotek se nezdařil.',
      importFailed: (detail) => (detail ? `Import se nezdařil: ${detail}` : 'Import se nezdařil.'),
    },
    videoErrors: {
      videoNotReady: 'Video ještě není na Google Photos zcela zpracované, zkuste to prosím za chvíli znovu.',
      videoTooLarge: 'Video je větší než povolený limit.',
      videoDownloadFailed: 'Nepodařilo se stáhnout video z Google Photos.',
      videoProcessingFailed: 'Zpracování videa se nezdařilo.',
      videoTooLong: 'Video je delší než povolený limit.',
      videoQueueFull: 'Fronta na zpracování videí je plná, zkuste to prosím za pár minut znovu.',
    },
  },
};

// Deep-partial override type + merge, used by every component's `labels`
// prop so a consumer can override exactly one string without retyping the
// whole preset. Functions are treated as leaf values (never recursed into).
export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSection<T extends object>(base: T, override?: DeepPartial<T>): T {
  if (!override) return base;
  const baseRecord = base as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };
  for (const key of Object.keys(override)) {
    const overrideValue = (override as Record<string, unknown>)[key];
    const baseValue = baseRecord[key];
    if (overrideValue === undefined) continue;
    result[key] =
      isPlainObject(overrideValue) && isPlainObject(baseValue) ? mergeSection(baseValue, overrideValue) : overrideValue;
  }
  return result as T;
}

/** Merges a partial label override onto `defaultLabels` (or any other
 *  full preset passed as `base`), one field deep into each section and
 *  two deep into `googlePhotos.errors`. Every field left unset keeps the
 *  base's value. */
export function mergeLabels(override?: DeepPartial<MediaBlockLabels>, base: MediaBlockLabels = defaultLabels): MediaBlockLabels {
  return {
    uploader: mergeSection<MediaUploaderLabels>(base.uploader, override?.uploader),
    cropEditor: mergeSection<PhotoCropEditorLabels>(base.cropEditor, override?.cropEditor),
    googlePhotos: mergeSection<GooglePhotosLabels>(base.googlePhotos, override?.googlePhotos),
  };
}
