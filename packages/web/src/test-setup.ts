import '@testing-library/jest-dom';

// jsdom does not implement the Blob URL helpers. Components that turn an
// authenticated fetch into a previewable blob: URL (DocumentThumb) call these
// on mount/unmount, so stub them for the test environment.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
