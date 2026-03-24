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
        previewMsgId: BigInt(0),
      },
    });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to upload preview image" };
  }
}

export async function updatePackageTags(
  packageId: string,
  tags: string[]
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const cleaned = tags.map((t) => t.trim()).filter(Boolean);
    // Deduplicate
    const unique = [...new Set(cleaned)];
    await prisma.package.update({
      where: { id: packageId },
      data: { tags: unique },
    });
    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update tags" };
  }
}

export async function bulkSetTags(
  packageIds: string[],
  tags: string[]
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    await prisma.package.updateMany({
      where: { id: { in: packageIds } },
      data: { tags: cleaned },
    });
    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update tags" };
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
        previewMsgId: BigInt(0),
      },
    });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to set preview from archive image" };
  }
}

export async function retrySkippedPackageAction(
  id: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const skipped = await prisma.skippedPackage.findUnique({
      where: { id },
    });
    if (!skipped) return { success: false, error: "Skipped package not found" };

    // Find the AccountChannelMap and reset watermark if needed
    const mapping = await prisma.accountChannelMap.findUnique({
      where: {
        accountId_channelId: {
          accountId: skipped.accountId,
          channelId: skipped.sourceChannelId,
        },
      },
    });

    if (mapping) {
      const targetId = skipped.sourceMessageId - 1n;

      // Only reset if the watermark is past this message
      if (mapping.lastProcessedMessageId && mapping.lastProcessedMessageId >= skipped.sourceMessageId) {
        await prisma.accountChannelMap.update({
          where: { id: mapping.id },
          data: { lastProcessedMessageId: targetId },
        });
      }

      // Also reset TopicProgress if this was a forum topic message
      if (skipped.sourceTopicId) {
        const topicProgress = await prisma.topicProgress.findFirst({
          where: {
            accountChannelMapId: mapping.id,
            topicId: skipped.sourceTopicId,
          },
        });
        if (topicProgress && topicProgress.lastProcessedMessageId && topicProgress.lastProcessedMessageId >= skipped.sourceMessageId) {
          await prisma.topicProgress.update({
            where: { id: topicProgress.id },
            data: { lastProcessedMessageId: targetId },
          });
        }
      }
    }

    // Delete the skip record
    await prisma.skippedPackage.delete({ where: { id } });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to retry skipped package" };
  }
}

export async function retryAllSkippedPackagesAction(
  reason?: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED"
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const where: Record<string, unknown> = {};
    if (reason) where.reason = reason;

    const skippedItems = await prisma.skippedPackage.findMany({ where });

    if (skippedItems.length === 0) {
      return { success: true, data: undefined };
    }

    // Group by (accountId, channelId) to find minimum messageId per channel
    const channelResets = new Map<string, { mappingKey: { accountId: string; channelId: string }; minMessageId: bigint; topicResets: Map<bigint, bigint> }>();

    for (const item of skippedItems) {
      const key = `${item.accountId}:${item.sourceChannelId}`;
      const existing = channelResets.get(key);
      const targetId = item.sourceMessageId - 1n;

      if (!existing) {
        const topicResets = new Map<bigint, bigint>();
        if (item.sourceTopicId) {
          topicResets.set(item.sourceTopicId, targetId);
        }
        channelResets.set(key, {
          mappingKey: { accountId: item.accountId, channelId: item.sourceChannelId },
          minMessageId: targetId,
          topicResets,
        });
      } else {
        if (targetId < existing.minMessageId) {
          existing.minMessageId = targetId;
        }
        if (item.sourceTopicId) {
          const existingTopic = existing.topicResets.get(item.sourceTopicId);
          if (!existingTopic || targetId < existingTopic) {
            existing.topicResets.set(item.sourceTopicId, targetId);
          }
        }
      }
    }

    // Reset watermarks
    for (const reset of channelResets.values()) {
      const mapping = await prisma.accountChannelMap.findUnique({
        where: { accountId_channelId: reset.mappingKey },
      });
      if (!mapping) continue;

      if (mapping.lastProcessedMessageId && mapping.lastProcessedMessageId > reset.minMessageId) {
        await prisma.accountChannelMap.update({
          where: { id: mapping.id },
          data: { lastProcessedMessageId: reset.minMessageId },
        });
      }

      // Reset topic progress
      for (const [topicId, targetId] of reset.topicResets) {
        const topicProgress = await prisma.topicProgress.findFirst({
          where: { accountChannelMapId: mapping.id, topicId },
        });
        if (topicProgress && topicProgress.lastProcessedMessageId && topicProgress.lastProcessedMessageId > targetId) {
          await prisma.topicProgress.update({
            where: { id: topicProgress.id },
            data: { lastProcessedMessageId: targetId },
          });
        }
      }
    }

    // Delete all matching skip records
    await prisma.skippedPackage.deleteMany({ where });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to retry skipped packages" };
  }
}
