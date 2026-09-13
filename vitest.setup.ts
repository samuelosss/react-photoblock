import '@testing-library/jest-dom/vitest';

// jsdom does not implement createObjectURL/revokeObjectURL. PhotoUploader
// calls both for every picked-file preview, so any test that picks a file
// needs these to exist — a fixed, distinguishable fake URL per call is
// enough; nothing in the suite inspects its actual bytes.
if (typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  URL.createObjectURL = () => `blob:mock-${(counter += 1)}`;
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
