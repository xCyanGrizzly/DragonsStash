"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { locationSchema } from "@/schemas/location.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function createLocation(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = locationSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  try {
    const location = await prisma.location.create({
      data: {
        ...parsed.data,
        description: parsed.data.description || null,
        userId: session.user.id,
      },
    });

    revalidatePath("/locations");
    return { success: true, data: { id: location.id } };
  } catch {
    return { success: false, error: "Failed to create location" };
  }
}

export async function updateLocation(id: string, input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = locationSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  const existing = await prisma.location.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.location.update({
      where: { id },
      data: {
        ...parsed.data,
        description: parsed.data.description || null,
      },
    });

    revalidatePath("/locations");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update location" };
  }
}

export async function deleteLocation(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.location.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.location.delete({ where: { id } });
    revalidatePath("/locations");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete location" };
  }
}

export async function archiveLocation(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.location.findFirst({ where: { id, userId: session.user.id } });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.location.update({
      where: { id },
      data: { archived: !existing.archived },
    });
    revalidatePath("/locations");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to archive location" };
  }
}
