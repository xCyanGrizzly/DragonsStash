"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resinSchema } from "@/schemas/resin.schema";
import { usageLogSchema } from "@/schemas/usage-log.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createResin(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = resinSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const resin = await prisma.resin.create({
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        resinType: parsed.data.resinType,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        bottleSize: parsed.data.bottleSize,
        usedML: parsed.data.usedML,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/resins");
    revalidatePath("/dashboard");
    return { success: true, data: { id: resin.id } };
  } catch {
    return { success: false, error: "Failed to create resin" };
  }
}

export async function updateResin(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = resinSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.resin.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.resin.update({
      where: { id },
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        resinType: parsed.data.resinType,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        bottleSize: parsed.data.bottleSize,
        usedML: parsed.data.usedML,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
      },
    });

    revalidatePath("/resins");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update resin" };
  }
}

export async function deleteResin(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.resin.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.resin.delete({ where: { id } });
    revalidatePath("/resins");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete resin" };
  }
}

export async function archiveResin(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.resin.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.resin.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/resins");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive resin" };
  }
}

export async function logResinUsage(resinId: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = usageLogSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.resin.findFirst({ where: { id: resinId, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.$transaction([
      prisma.usageLog.create({
        data: {
          itemType: "RESIN",
          itemId: resinId,
          resinId,
          amount: parsed.data.amount,
          unit: "ml",
          notes: parsed.data.notes || null,
          userId: session.user.id,
        },
      }),
      prisma.resin.update({
        where: { id: resinId },
        data: { usedML: { increment: parsed.data.amount } },
      }),
    ]);

    revalidatePath("/resins");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to log usage" };
  }
}
