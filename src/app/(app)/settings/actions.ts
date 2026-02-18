"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { settingsSchema } from "@/schemas/settings.schema";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";

export async function updateSettings(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    await prisma.userSettings.upsert({
      where: { userId: session.user.id },
      update: {
        lowStockThreshold: parsed.data.lowStockThreshold,
        currency: parsed.data.currency,
        theme: parsed.data.theme,
        units: parsed.data.units,
      },
      create: {
        userId: session.user.id,
        lowStockThreshold: parsed.data.lowStockThreshold,
        currency: parsed.data.currency,
        theme: parsed.data.theme,
        units: parsed.data.units,
      },
    });

    revalidatePath("/settings");
    revalidatePath("/dashboard");
    revalidatePath("/filaments");
    revalidatePath("/resins");
    revalidatePath("/paints");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update settings" };
  }
}
