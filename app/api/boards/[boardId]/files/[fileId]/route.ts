import { handleBoardFileDownload } from "@/lib/boards/file-http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Serve one image back to somebody who may view the board. */
export async function GET(
  request: Request,
  context: { params: Promise<{ boardId: string; fileId: string }> },
): Promise<Response> {
  const { boardId, fileId } = await context.params;
  return handleBoardFileDownload(db, request, boardId, fileId);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ boardId: string; fileId: string }> },
): Promise<Response> {
  const { boardId, fileId } = await context.params;
  return handleBoardFileDownload(db, request, boardId, fileId);
}
