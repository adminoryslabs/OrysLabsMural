import { handleBoardFileUpload } from "@/lib/boards/file-http";
import { db } from "@/lib/db";

// The verdict depends on the session cookie and on a board status that a
// teacher can change at any moment. Nothing here may ever be prerendered.
export const dynamic = "force-dynamic";

/**
 * Upload the bytes of one image. An adapter: the authorisation and the rules
 * live in `lib/boards/file-http.ts`, where the test suite drives them.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ boardId: string }> },
): Promise<Response> {
  const { boardId } = await context.params;
  return handleBoardFileUpload(db, request, boardId);
}
