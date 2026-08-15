/**
 * Where the browser should open its collaboration websocket.
 *
 * `NEXT_PUBLIC_YJS_URL` is inlined at build time, so it must be read as a
 * literal property access rather than through a computed lookup.
 * In production it is `wss://<domain>/yjs`, which Caddy proxies to the Yjs
 * container; locally the server is reachable directly on port 1234.
 */
export const DEFAULT_YJS_URL = "ws://localhost:1234";

export function yjsServerUrl(): string {
  const configured = process.env.NEXT_PUBLIC_YJS_URL;
  return configured && configured.length > 0 ? configured : DEFAULT_YJS_URL;
}
