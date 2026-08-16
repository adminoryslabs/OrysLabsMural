/**
 * THE BROWSER SIDE OF THE BINARY ASSET STORE.
 *
 * Only the `fileId` of an image travels through the Yjs document — it is
 * already part of the image element, so nothing new goes on the wire. The bytes
 * move over HTTP, once per client, through the two routes in
 * `app/api/boards/[boardId]/files`.
 *
 * Framework free on purpose: the parsing and classification below are the parts
 * worth testing, and they run in Node as happily as in a browser.
 */

/** Enough of an Excalidraw image element for the sync pass to reason about. */
interface MaybeImageElement {
  type?: string;
  isDeleted?: boolean;
  fileId?: string | null;
}

/**
 * Which files the scene actually needs right now.
 *
 * Deleted elements are excluded deliberately. Excalidraw keeps a file around
 * after its element is removed, and uploading those would push bytes nobody can
 * see — including, on the rejection path, the very element we have just thrown
 * away because the server refused it.
 */
export function referencedFileIds(
  elements: readonly MaybeImageElement[],
): Set<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    if (element.type !== "image" || element.isDeleted) continue;
    if (typeof element.fileId === "string" && element.fileId.length > 0) {
      ids.add(element.fileId);
    }
  }
  return ids;
}

export function boardFileUrl(boardId: string, fileId: string): string {
  return `/api/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(
    fileId,
  )}`;
}

/**
 * Decodes the `data:` URL Excalidraw holds an image in back into raw bytes.
 *
 * Excalidraw always produces a base64 data URL for a pasted or dropped image,
 * so the percent-encoded form is not handled: refusing it is better than
 * guessing and uploading something corrupt.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;

  const header = dataUrl.slice(5, comma);
  if (!header.endsWith(";base64")) return null;
  const mimeType = header.slice(0, -";base64".length) || "application/octet-stream";

  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
    reader.readAsDataURL(blob);
  });
}

export type UploadOutcome =
  | { ok: true }
  /**
   * `retry: false` means the server will never accept this file: too large,
   * wrong format, or a board that may not be written to. The caller must take
   * the orphaned element off the canvas rather than leave a picture that can
   * never load for anyone else.
   */
  | { ok: false; retry: boolean; message: string };

/**
 * Turns the server's refusal into something worth showing a student mid-class.
 * Anything unrecognised is treated as transient: a retry is cheap, and silently
 * deleting somebody's work over an unknown status code is not.
 */
export function describeUploadFailure(
  status: number,
  body: { error?: unknown; limit?: unknown } | null,
): { retry: boolean; message: string } {
  const limit = typeof body?.limit === "number" ? body.limit : null;
  switch (status) {
    case 413:
      return {
        retry: false,
        message: limit
          ? `That image is larger than the ${formatBytes(limit)} limit, so it was removed.`
          : "That image is too large, so it was removed.",
      };
    case 415:
      return {
        retry: false,
        message:
          "That file type is not supported. Use a PNG, JPEG, WebP or GIF.",
      };
    case 403:
      return {
        retry: false,
        message:
          "This board is not accepting changes right now, so the image was removed.",
      };
    case 400:
      return {
        retry: false,
        message: "That image could not be read, so it was removed.",
      };
    case 401:
      return {
        retry: false,
        message: "Your session has expired. Reload the page and sign in again.",
      };
    case 404:
      return {
        retry: false,
        message: "This board is no longer available, so the image was removed.",
      };
    default:
      return {
        retry: true,
        message: "The image could not be uploaded. Retrying…",
      };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/** POSTs one image. The cookie rides along because this is our own origin. */
export async function uploadBoardFile(
  boardId: string,
  fileId: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("fileId", fileId);
  form.append("file", blob, fileId);

  let response: Response;
  try {
    response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/files`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
      signal,
    });
  } catch {
    // Offline, or the request was aborted on unmount. Neither is the user's
    // image being wrong, so the element stays and the next pass tries again.
    return { ok: false, retry: true, message: "" };
  }

  if (response.ok) return { ok: true };

  let body: { error?: unknown; limit?: unknown } | null = null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = null;
  }
  const { retry, message } = describeUploadFailure(response.status, body);
  return { ok: false, retry, message };
}

export type FetchOutcome =
  | { ok: true; blob: Blob }
  /** `retry` distinguishes "not uploaded yet" from "never coming". */
  | { ok: false; retry: boolean };

/**
 * GETs one image. A 404 is expected and transient: the peer who pasted it may
 * still be uploading, so the element arrives over the socket before the bytes
 * exist. The caller retries a bounded number of times.
 */
export async function fetchBoardFile(
  boardId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(boardFileUrl(boardId, fileId), {
      credentials: "same-origin",
      signal,
    });
  } catch {
    return { ok: false, retry: true };
  }

  if (response.ok) return { ok: true, blob: await response.blob() };
  // 401 means the session is gone; reloading is the user's job, not ours.
  return { ok: false, retry: response.status === 404 };
}
