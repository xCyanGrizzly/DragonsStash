"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { vendorSchema } from "@/schemas/vendor.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = vendorSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  try {
    const vendor = await prisma.vendor.create({
      data: {
        ...parsed.data,
        website: parsed.data.website || null,
        notes: parsed.data.notes || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/vendors");
    return { success: true, data: { id: vendor.id } };
  } catch {
    return { success: false, error: "Failed to create vendor" };
  }
}

export async function updateVendor(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = vendorSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  const existing = await prisma.vendor.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.vendor.update({
      where: { id },
      data: {
        ...parsed.data,
        website: parsed.data.website || null,
        notes: parsed.data.notes || null,
      },
    });

    revalidatePath("/vendors");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update vendor" };
  }
}

export async function deleteVendor(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.vendor.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.vendor.delete({ where: { id } });
    revalidatePath("/vendors");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete vendor" };
  }
}

export async function archiveVendor(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.vendor.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.vendor.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/vendors");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive vendor" };
  }
}
