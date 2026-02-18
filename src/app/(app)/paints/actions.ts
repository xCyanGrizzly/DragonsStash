"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { paintSchema } from "@/schemas/paint.schema";
import { usageLogSchema } from "@/schemas/usage-log.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createPaint(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = paintSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const paint = await prisma.paint.create({
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        line: parsed.data.line || null,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        finish: parsed.data.finish,
        volumeML: parsed.data.volumeML,
        usedML: parsed.data.usedML,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/paints");
    revalidatePath("/dashboard");
    return { success: true, data: { id: paint.id } };
  } catch {
    return { success: false, error: "Failed to create paint" };
  }
}

export async function updatePaint(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = paintSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.paint.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.paint.update({
      where: { id },
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        line: parsed.data.line || null,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        finish: parsed.data.finish,
        volumeML: parsed.data.volumeML,
        usedML: parsed.data.usedML,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
      },
    });

    revalidatePath("/paints");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update paint" };
  }
}

export async function deletePaint(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.paint.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.paint.delete({ where: { id } });
    revalidatePath("/paints");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete paint" };
  }
}

export async function archivePaint(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.paint.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.paint.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/paints");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive paint" };
  }
}

export async function logPaintUsage(paintId: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = usageLogSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.paint.findFirst({ where: { id: paintId, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.$transaction([
      prisma.usageLog.create({
        data: {
          itemType: "PAINT",
          itemId: paintId,
          paintId,
          amount: parsed.data.amount,
          unit: "ml",
          notes: parsed.data.notes || null,
          userId: session.user.id,
        },
      }),
      prisma.paint.update({
        where: { id: paintId },
        data: { usedML: { increment: parsed.data.amount } },
      }),
    ]);

    revalidatePath("/paints");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to log usage" };
  }
}
