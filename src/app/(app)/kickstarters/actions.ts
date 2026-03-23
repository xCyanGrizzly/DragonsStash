"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { kickstarterSchema, kickstarterHostSchema } from "@/schemas/kickstarter.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

const REVALIDATE_PATH = "/kickstarters";

export async function createKickstarter(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = kickstarterSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const ks = await prisma.kickstarter.create({
      data: {
        name: parsed.data.name,
        link: parsed.data.link || null,
        filesUrl: parsed.data.filesUrl || null,
        deliveryStatus: parsed.data.deliveryStatus,
        paymentStatus: parsed.data.paymentStatus,
        hostId: parsed.data.hostId || null,
        notes: parsed.data.notes || null,
        userId: session.user.id,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: ks.id } };
  } catch {
    return { success: false, error: "Failed to create kickstarter" };
  }
}

export async function updateKickstarter(
  id: string,
  input: unknown
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = kickstarterSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.kickstarter.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.kickstarter.update({
      where: { id },
      data: {
        name: parsed.data.name,
        link: parsed.data.link || null,
        filesUrl: parsed.data.filesUrl || null,
        deliveryStatus: parsed.data.deliveryStatus,
        paymentStatus: parsed.data.paymentStatus,
        hostId: parsed.data.hostId || null,
        notes: parsed.data.notes || null,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update kickstarter" };
  }
}

export async function deleteKickstarter(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.kickstarter.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!existing) return { success: false, error: "Not found" };

  try {
    await prisma.kickstarter.delete({ where: { id } });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete kickstarter" };
  }
}

export async function createHost(
  input: unknown
): Promise<ActionResult<{ id: string; name: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = kickstarterHostSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const host = await prisma.kickstarterHost.create({
      data: { name: parsed.data.name },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: host.id, name: host.name } };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint")
    ) {
      return { success: false, error: "A host with that name already exists" };
    }
    return { success: false, error: "Failed to create host" };
  }
}

export async function linkPackages(
  kickstarterId: string,
  packageIds: string[]
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const existing = await prisma.kickstarter.findFirst({
    where: { id: kickstarterId, userId: session.user.id },
  });
  if (!existing) return { success: false, error: "Not found" };

  try {
    // Replace all linked packages
    await prisma.$transaction([
      prisma.kickstarterPackage.deleteMany({
        where: { kickstarterId },
      }),
      ...packageIds.map((packageId) =>
        prisma.kickstarterPackage.create({
          data: { kickstarterId, packageId },
        })
      ),
    ]);
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to link packages" };
  }
}
