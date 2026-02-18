"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { filamentSchema } from "@/schemas/filament.schema";
import { usageLogSchema } from "@/schemas/usage-log.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createFilament(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = filamentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  try {
    const filament = await prisma.filament.create({
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        material: parsed.data.material,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        diameter: parsed.data.diameter,
        spoolWeight: parsed.data.spoolWeight,
        usedWeight: parsed.data.usedWeight,
        emptySpoolWeight: parsed.data.emptySpoolWeight,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/filaments");
    revalidatePath("/dashboard");
    return { success: true, data: { id: filament.id } };
  } catch {
    return { success: false, error: "Failed to create filament" };
  }
}

export async function updateFilament(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = filamentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  const existing = await prisma.filament.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.filament.update({
      where: { id },
      data: {
        name: parsed.data.name,
        brand: parsed.data.brand,
        material: parsed.data.material,
        color: parsed.data.color,
        colorHex: parsed.data.colorHex,
        diameter: parsed.data.diameter,
        spoolWeight: parsed.data.spoolWeight,
        usedWeight: parsed.data.usedWeight,
        emptySpoolWeight: parsed.data.emptySpoolWeight,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : null,
        cost: parsed.data.cost ?? null,
        notes: parsed.data.notes || null,
        vendorId: parsed.data.vendorId || null,
        locationId: parsed.data.locationId || null,
      },
    });

    revalidatePath("/filaments");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update filament" };
  }
}

export async function deleteFilament(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.filament.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.filament.delete({ where: { id } });
    revalidatePath("/filaments");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete filament" };
  }
}

export async function archiveFilament(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.filament.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.filament.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/filaments");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive filament" };
  }
}

export async function logFilamentUsage(
  filamentId: string,
  input: unknown
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = usageLogSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  const existing = await prisma.filament.findFirst({
    where: { id: filamentId, userId: session.user.id },
  });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.$transaction([
      prisma.usageLog.create({
        data: {
          itemType: "FILAMENT",
          itemId: filamentId,
          filamentId,
          amount: parsed.data.amount,
          unit: "g",
          notes: parsed.data.notes || null,
          userId: session.user.id,
        },
      }),
      prisma.filament.update({
        where: { id: filamentId },
        data: { usedWeight: { increment: parsed.data.amount } },
      }),
    ]);

    revalidatePath("/filaments");
    revalidatePath("/dashboard");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to log usage" };
  }
}
