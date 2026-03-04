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

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });

  if (existing) {
    return { success: false, error: "An account with this email already exists" };
  }

  const hashedPassword = await bcrypt.hash(parsed.data.password, 10);

  // First user to register becomes ADMIN (self-hosted owner)
  const user = await prisma.$transaction(async (tx) => {
    const userCount = await tx.user.count();
    const role = userCount === 0 ? "ADMIN" : "USER";

    return tx.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        hashedPassword,
        role,
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
  });

  return { success: true, data: { id: user.id } };
}
