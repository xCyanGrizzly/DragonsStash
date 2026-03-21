"use server";

import crypto from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/types/api.types";
import { revalidatePath } from "next/cache";

export async function createInviteCode(input: {
  maxUses: number;
  expiresInDays: number | null;
}): Promise<ActionResult<{ code: string }>> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return { success: false, error: "Unauthorized" };
  }

  const code = crypto.randomBytes(6).toString("hex");
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  await prisma.inviteCode.create({
    data: {
      code,
      maxUses: input.maxUses,
      expiresAt,
      createdBy: session.user.id,
    },
  });

  revalidatePath("/invites");
  return { success: true, data: { code } };
}

export async function deleteInviteCode(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return { success: false, error: "Unauthorized" };
  }

  await prisma.inviteCode.delete({ where: { id } });

  revalidatePath("/invites");
  return { success: true, data: undefined };
}

export async function getInviteCodes() {
  const codes = await prisma.inviteCode.findMany({
    orderBy: { createdAt: "desc" },
    include: { creator: { select: { name: true } } },
  });
  return codes;
}
