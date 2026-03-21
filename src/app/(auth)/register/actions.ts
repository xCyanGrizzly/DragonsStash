"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/schemas/auth.schema";
import type { ActionResult } from "@/types/api.types";

export async function registerUser(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Validation failed" };
  }

  // Validate invite code
  const invite = await prisma.inviteCode.findUnique({
    where: { code: parsed.data.inviteCode },
  });

  if (!invite) {
    return { success: false, error: "Invalid invite code" };
  }

  if (invite.uses >= invite.maxUses) {
    return { success: false, error: "This invite code has already been used" };
  }

  if (invite.expiresAt && invite.expiresAt < new Date()) {
    return { success: false, error: "This invite code has expired" };
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });

  if (existing) {
    return { success: false, error: "An account with this email already exists" };
  }

  const hashedPassword = await bcrypt.hash(parsed.data.password, 10);

  // Create user and increment invite usage in a transaction
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        hashedPassword,
        role: "USER",
        settings: {
          create: {
            lowStockThreshold: 10,
            currency: "USD",
            theme: "dark",
            units: "metric",
          },
        },
      },
    });

    await tx.inviteCode.update({
      where: { id: invite.id },
      data: { uses: { increment: 1 } },
    });

    return newUser;
  });

  return { success: true, data: { id: user.id } };
}
