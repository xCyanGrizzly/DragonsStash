"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import type { ActionResult } from "@/types/api.types";

const batchEntrySchema = z.object({
  itemType: z.enum(["FILAMENT", "RESIN", "PAINT", "SUPPLY"]),
  itemId: z.string().min(1),
  amount: z.coerce.number().positive("Amount must be positive"),
  notes: z.string().max(512).optional(),
});

const batchUsageSchema = z.object({
  entries: z.array(batchEntrySchema).min(1, "At least one entry is required"),
});

export async function logBatchUsage(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = batchUsageSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  const { entries } = parsed.data;
  const userId = session.user.id;

  try {
    // Verify ownership of all items and build transaction operations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const operations: any[] = [];
    const affectedPaths = new Set<string>();

    for (const entry of entries) {
      switch (entry.itemType) {
        case "FILAMENT": {
          const item = await prisma.filament.findFirst({
            where: { id: entry.itemId, userId },
          });
          if (!item) return { success: false, error: `Filament not found` };

          operations.push(
            prisma.usageLog.create({
              data: {
                itemType: "FILAMENT",
                itemId: entry.itemId,
                filamentId: entry.itemId,
                amount: entry.amount,
                unit: "g",
                notes: entry.notes || null,
                userId,
              },
            }),
            prisma.filament.update({
              where: { id: entry.itemId },
              data: { usedWeight: { increment: entry.amount } },
            })
          );
          affectedPaths.add("/filaments");
          break;
        }
        case "RESIN": {
          const item = await prisma.resin.findFirst({
            where: { id: entry.itemId, userId },
          });
          if (!item) return { success: false, error: `Resin not found` };

          operations.push(
            prisma.usageLog.create({
              data: {
                itemType: "RESIN",
                itemId: entry.itemId,
                resinId: entry.itemId,
                amount: entry.amount,
                unit: "ml",
                notes: entry.notes || null,
                userId,
              },
            }),
            prisma.resin.update({
              where: { id: entry.itemId },
              data: { usedML: { increment: entry.amount } },
            })
          );
          affectedPaths.add("/resins");
          break;
        }
        case "PAINT": {
          const item = await prisma.paint.findFirst({
            where: { id: entry.itemId, userId },
          });
          if (!item) return { success: false, error: `Paint not found` };

          operations.push(
            prisma.usageLog.create({
              data: {
                itemType: "PAINT",
                itemId: entry.itemId,
                paintId: entry.itemId,
                amount: entry.amount,
                unit: "ml",
                notes: entry.notes || null,
                userId,
              },
            }),
            prisma.paint.update({
              where: { id: entry.itemId },
              data: { usedML: { increment: entry.amount } },
            })
          );
          affectedPaths.add("/paints");
          break;
        }
        case "SUPPLY": {
          const item = await prisma.supply.findFirst({
            where: { id: entry.itemId, userId },
          });
          if (!item) return { success: false, error: `Supply not found` };

          operations.push(
            prisma.usageLog.create({
              data: {
                itemType: "SUPPLY",
                itemId: entry.itemId,
                supplyId: entry.itemId,
                amount: entry.amount,
                unit: item.unit,
                notes: entry.notes || null,
                userId,
              },
            }),
            prisma.supply.update({
              where: { id: entry.itemId },
              data: { usedAmount: { increment: entry.amount } },
            })
          );
          affectedPaths.add("/supplies");
          break;
        }
      }
    }

    await prisma.$transaction(operations);

    // Revalidate all affected pages
    revalidatePath("/dashboard");
    revalidatePath("/usage");
    for (const path of affectedPaths) {
      revalidatePath(path);
    }

    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to log usage" };
  }
}
