import { handleIconDownload } from "@/lib/icons/icon-http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const { fileId } = await context.params;
  return handleIconDownload(db, request, fileId);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const { fileId } = await context.params;
  return handleIconDownload(db, request, fileId);
}
