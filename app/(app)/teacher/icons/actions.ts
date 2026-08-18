"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTeacher } from "@/lib/auth/current-user";
import {
  isAllowedImageMimeType,
  maxBoardFileBytes,
  sniffImageMimeType,
} from "@/lib/boards/files";
import { db } from "@/lib/db";
import { IconNameTakenError, saveIconCatalogEntry } from "@/lib/icons/icons";

export interface ActionState {
  error?: string;
  message?: string;
}

const createIconSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/,
      "Use lowercase letters, digits and hyphens only.",
    ),
  label: z.string().trim().min(1).max(120),
});

/**
 * Adds one icon to the global catalog. Re-authorises from the cookie like
 * every other teacher action in this app — the button being hidden for a
 * student proves nothing, this is a public endpoint underneath the form.
 */
export async function createIconAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireTeacher();

  const parsed = createIconSchema.safeParse({
    name: formData.get("name"),
    label: formData.get("label"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Check the name and label.",
    };
  }

  const part = formData.get("file");
  if (typeof part === "string" || part === null) {
    return { error: "Choose an image file." };
  }

  const limit = maxBoardFileBytes();
  if (part.size > limit) {
    return { error: "That image is too large." };
  }

  const bytes = new Uint8Array(await part.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { error: "That image is empty." };
  }

  const declaredType = part.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const sniffed = sniffImageMimeType(bytes);
  if (
    sniffed === null ||
    !isAllowedImageMimeType(declaredType) ||
    declaredType !== sniffed
  ) {
    return {
      error: "Only PNG, JPEG, WEBP or GIF images are accepted.",
    };
  }

  const teacher = await requireTeacher();
  try {
    await saveIconCatalogEntry(db, {
      name: parsed.data.name,
      label: parsed.data.label,
      mimeType: sniffed,
      bytes,
      createdBy: teacher.id,
    });
  } catch (error) {
    if (error instanceof IconNameTakenError) {
      return { error: error.message };
    }
    return { error: "The icon could not be saved." };
  }

  revalidatePath("/teacher/icons");
  return { message: `Icon "${parsed.data.name}" added.` };
}
