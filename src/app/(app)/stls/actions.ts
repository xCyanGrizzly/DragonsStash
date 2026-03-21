"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/types/api.types";
import { revalidatePath } from "next/cache";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2 MB

export async function updatePackageCreator(
  packageId: string,
  creator: string | null
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    await prisma.package.update({
      where: { id: packageId },
      data: { creator: creator?.trim() || null },
    });
    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update creator" };
  }
}

export async function uploadPackagePreview(
  packageId: string,
  formData: FormData
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { success: false, error: "No file provided" };
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return { success: false, error: "Only JPG, PNG, and WebP images are accepted" };
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return { success: false, error: "Image must be smaller than 2 MB" };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await prisma.package.update({
      where: { id: packageId },
      data: {
        previewData: buffer,
        // Set previewMsgId to 0 as sentinel so hasPreview checks work
        previewMsgId: 0n,
      },
    });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to upload preview image" };
  }
}

export async function bulkSetCreator(
  packageIds: string[],
  creator: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    await prisma.package.updateMany({
      where: { id: { in: packageIds } },
      data: { creator: creator.trim() },
    });
    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update creators" };
  }
}

/**
 * Set a package's preview from an extracted archive image.
 * Reads the image data from a completed ArchiveExtractRequest.
 */
export async function setPreviewFromExtract(
  packageId: string,
  extractRequestId: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const extractReq = await prisma.archiveExtractRequest.findUnique({
      where: { id: extractRequestId },
      select: { status: true, imageData: true, packageId: true },
    });

    if (!extractReq) {
      return { success: false, error: "Extract request not found" };
    }

    if (extractReq.packageId !== packageId) {
      return { success: false, error: "Extract request does not belong to this package" };
    }

    if (extractReq.status !== "COMPLETED" || !extractReq.imageData) {
      return { success: false, error: "Image extraction not yet completed" };
    }

    await prisma.package.update({
      where: { id: packageId },
      data: {
        previewData: extractReq.imageData,
        // Set previewMsgId to 0 as sentinel so hasPreview checks work
        // (original Telegram-matched previews have the actual message ID)
        previewMsgId: 0n,
      },
    });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to set preview from archive image" };
  }
}
