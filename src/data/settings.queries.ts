import { prisma } from "@/lib/prisma";

export async function getUserSettings(userId: string) {
  let settings = await prisma.userSettings.findUnique({
    where: { userId },
  });

  if (!settings) {
    settings = await prisma.userSettings.create({
      data: {
        userId,
        lowStockThreshold: 20,
        currency: "EUR",
        theme: "dark",
        units: "metric",
      },
    });
  }

  return settings;
}

export async function updateUserSettings(
  userId: string,
  data: {
    lowStockThreshold?: number;
    currency?: string;
    theme?: string;
    units?: string;
  }
) {
  return prisma.userSettings.upsert({
    where: { userId },
    update: data,
    create: {
      userId,
      lowStockThreshold: data.lowStockThreshold ?? 20,
      currency: data.currency ?? "EUR",
      theme: data.theme ?? "dark",
      units: data.units ?? "metric",
    },
  });
}
