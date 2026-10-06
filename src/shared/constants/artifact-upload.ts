/**
 * Largest file a remote client (browser or phone) may upload into a space.
 * Shared so the composer can refuse before sending a byte, and the upload
 * route enforces the same line while it streams the file to disk.
 */
export const MAX_UPLOAD_FILE_SIZE = 200 * 1024 * 1024
