"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supplySchema } from "@/schemas/supply.schema";
import { usageLogSchema } from "@/schemas/usage-log.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createSupply(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = supplySchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const supply = await prisma.supply.create({
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        category: parsed.data.category,
        color: parsed.data.color || null,
        colorHex: parsed.data.colorHex || null,
        totalAmount: parsed.data.totalAmount,
        usedAmount: parsed.data.usedAmount,
        unit: parsed.data.unit,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/supplies");
    revalidatePath("/dashboard");
    return { success: true, data: { id: supply.id } };
  } catch {
    return { success: false, error: "Failed to create supply" };
  }
}

export async function updateSupply(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = supplySchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.supply.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.supply.update({
      where: { id },
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        category: parsed.data.category,
        color: parsed.data.color || null,
        colorHex: parsed.data.colorHex || null,
        totalAmount: parsed.data.totalAmount,
        usedAmount: parsed.data.usedAmount,
        unit: parsed.data.unit,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
      },
    });

    revalidatePath("/supplies");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update supply" };
  }
}

export async function deleteSupply(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.supply.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.supply.delete({ where: { id } });
    revalidatePath("/supplies");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete supply" };
  }
}

export async function archiveSupply(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.supply.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.supply.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/supplies");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive supply" };
  }
}

export async function logSupplyUsage(supplyId: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = usageLogSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.supply.findFirst({ where: { id: supplyId, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.$transaction([
      prisma.usageLog.create({
        data: {
          itemType: "SUPPLY",
          itemId: supplyId,
          supplyId,
          amount: parsed.data.amount,
          unit: existing.unit,
          notes: parsed.data.notes || null,
          userId: session.user.id,
        },
      }),
      prisma.supply.update({
        where: { id: supplyId },
        data: { usedAmount: { increment: parsed.data.amount } },
      }),
    ]);

    revalidatePath("/supplies");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to log usage" };
  }
}
