import { handleIconCatalogList, handleIconCatalogUpload } from "@/lib/icons/icon-http";
import { db } from "@/lib/db";

// The verdict depends on the session cookie. Never prerendered.
export const dynamic = "force-dynamic";

/** List the catalog's names and labels — never the bytes. */
export async function GET(request: Request): Promise<Response> {
  return handleIconCatalogList(db, request);
}

/** Add one icon. Teacher-gated inside the handler. */
export async function POST(request: Request): Promise<Response> {
  return handleIconCatalogUpload(db, request);
}
