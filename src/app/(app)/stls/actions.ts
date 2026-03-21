"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/types/api.types";
import { revalidatePath } from "next/cache";

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
