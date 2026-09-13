/**
 * Every visible string and every aria-label PhotoUploader, PhotoCropEditor
 * and the Google Photos picker can render, as one typed, overridable
 * structure. Nothing in src/components or src/googlePhotos hardcodes UI
 * text — it all comes from a `labels` prop, defaulted to `defaultLabels`
 * (English) below. `csLabels` is a complete Czech translation, the one
 * this package's components originally shipped with in production, kept
 * as a ready-made preset since it already exists and is proven.
 */

export interface PhotoUploaderLabels {
  /** Dropzone label while nothing is being dragged over it. */
  dropzoneIdle: string;
  /** Dropzone label while a drag is over it. */
  dropzoneActive: string;
  /** Hint paragraph under the dropzone. `entitySaved` is false before the
   *  owning entity has ever been saved (see PhotoUploaderProps.entityId) —
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
  /** Screen-reader announcement after a successful reorder. All 1-based. */
  moveAnnouncement: (fromPosition: number, toPosition: number, total: number) => string;
  /** window.alert() text if saving a crop fails. */
  cropSaveFailedAlert: string;
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

export interface GooglePhotosLabels {
  pickButton: string;
  connecting: string;
  picking: string;
  importing: string;
  cancel: string;
  /** Shown after a successful import — the popup usually can't be closed
   *  programmatically by then (see docs/google-photos-setup.md), so this
   *  is the one thing the user still needs telling. */
  importedNotice: (count: number) => string;
  errors: GooglePhotosErrorLabels;
}

export interface PhotoBlockLabels {
  uploader: PhotoUploaderLabels;
  cropEditor: PhotoCropEditorLabels;
  googlePhotos: GooglePhotosLabels;
}

const uploaderHintBase =
  'Choose photos from your library, or drag them in. Each photo max 15 MB, up to 10 at a time. ' +
  'Click a photo to edit it (crop, rotate).';

export const defaultLabels: PhotoBlockLabels = {
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
    cropSaveFailedAlert: 'Editing the photo failed.',
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
    connecting: 'Connecting…',
    picking: 'Waiting for you to pick in the popup…',
    importing: 'Importing selected photos…',
    cancel: 'Cancel',
    importedNotice: (count) =>
      `${count} photo${count === 1 ? '' : 's'} imported — you can close the Google Photos window.`,
    errors: {
      googleNotConfigured: 'Google Photos picking is not set up yet.',
      invalidState: 'Verification failed, please try again.',
      missingCode: 'Signing in to Google failed, please try again.',
      oauthFailed: 'Signing in to Google failed, please try again.',
      pickerSessionFailed: 'Could not open the photo picker, please try again.',
      sessionExpired: 'Time to pick photos ran out, please try again.',
      bridgeTimeout: 'Signing in to Google took too long, please try again.',
      popupBlocked: 'Your browser blocked the popup. Allow popups for this page and try again.',
      generic: 'Something went wrong, please try again.',
      startFailed: (detail) => detail ?? 'Could not start the photo picker.',
      pollFailed: (detail) => detail ?? 'Picking photos failed.',
      importFailed: (detail) => (detail ? `Importing photos failed: ${detail}` : 'Importing photos failed.'),
    },
  },
};

/**
 * Czech preset — a verbatim port of the strings this package's components
 * shipped with in their origin production use, kept as a ready-made
 * alternative to typing out a full translation. Not the default: this is
 * a general-purpose package, so English is the neutral starting point,
 * and any locale (including this one) is opted into via the `labels`
 * prop, e.g. `<PhotoUploader labels={csLabels} ... />`.
 */
const csUploaderHintBase =
  'Vyberte fotky z knihovny telefonu, nebo je přetáhněte myší. Každá fotka max. 15 MB, ' +
  'najednou lze vybrat až 10 fotek. Kliknutím na fotku ji můžete upravit (výřez, otočení).';

function csImportedPhotosLabel(count: number): string {
  if (count === 1) return 'Fotka je nahraná';
  if (count >= 2 && count <= 4) return `${count} fotky jsou nahrané`;
  return `${count} fotek je nahraných`;
}

export const csLabels: PhotoBlockLabels = {
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
    cropSaveFailedAlert: 'Úprava fotky se nezdařila.',
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
    pickButton: 'Vybrat z Google Photos',
    connecting: 'Připojování…',
    picking: 'Čeká se na výběr ve vyskakovacím okně…',
    importing: 'Importuji vybrané fotky…',
    cancel: 'Zrušit',
    importedNotice: (count) => `${csImportedPhotosLabel(count)} — okno Google Photos můžete zavřít.`,
    errors: {
      googleNotConfigured: 'Výběr z Google Photos zatím není nastaven.',
      invalidState: 'Ověření se nezdařilo, zkuste to prosím znovu.',
      missingCode: 'Přihlášení ke Google se nezdařilo, zkuste to prosím znovu.',
      oauthFailed: 'Přihlášení ke Google se nezdařilo, zkuste to prosím znovu.',
      pickerSessionFailed: 'Nepodařilo se otevřít výběr fotek, zkuste to prosím znovu.',
      sessionExpired: 'Čas na výběr fotek vypršel, zkuste to prosím znovu.',
      bridgeTimeout: 'Přihlášení ke Google trvalo příliš dlouho, zkuste to prosím znovu.',
      popupBlocked: 'Prohlížeč zablokoval vyskakovací okno. Povolte vyskakovací okna pro tuto stránku a zkuste to znovu.',
      generic: 'Něco se nepovedlo, zkuste to prosím znovu.',
      startFailed: (detail) => detail ?? 'Nepodařilo se spustit výběr fotek.',
      pollFailed: (detail) => detail ?? 'Výběr fotek se nezdařil.',
      importFailed: (detail) => (detail ? `Import fotek se nezdařil: ${detail}` : 'Import fotek se nezdařil.'),
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
export function mergeLabels(override?: DeepPartial<PhotoBlockLabels>, base: PhotoBlockLabels = defaultLabels): PhotoBlockLabels {
  return {
    uploader: mergeSection<PhotoUploaderLabels>(base.uploader, override?.uploader),
    cropEditor: mergeSection<PhotoCropEditorLabels>(base.cropEditor, override?.cropEditor),
    googlePhotos: mergeSection<GooglePhotosLabels>(base.googlePhotos, override?.googlePhotos),
  };
}
