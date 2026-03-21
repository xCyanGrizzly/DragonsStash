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

export async function createBulkInviteCodes(input: {
  count: number;
  maxUses: number;
  expiresInDays: number | null;
}): Promise<ActionResult<{ codes: string[] }>> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return { success: false, error: "Unauthorized" };
  }

  if (input.count < 1 || input.count > 25) {
    return { success: false, error: "Can generate between 1 and 25 codes at a time" };
  }

  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const codes: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < input.count; i++) {
      const code = crypto.randomBytes(6).toString("hex");
      codes.push(code);
      await tx.inviteCode.create({
        data: {
          code,
          maxUses: input.maxUses,
          expiresAt,
          createdBy: session.user.id,
        },
      });
    }
  });

  revalidatePath("/invites");
  return { success: true, data: { codes } };
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
    include: {
      creator: { select: { name: true } },
      usedBy: { select: { id: true, name: true, email: true, createdAt: true } },
    },
  });
  return codes;
}
