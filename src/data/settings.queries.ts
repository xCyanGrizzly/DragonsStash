import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const DEFAULT_SETTINGS = {
  lowStockThreshold: 20,
  currency: "EUR",
  theme: "dark",
  units: "metric",
} as const;

export async function getUserSettings(userId: string) {
  let settings = await prisma.userSettings.findUnique({
    where: { userId },
  });

  if (!settings) {
    try {
      settings = await prisma.userSettings.create({
        data: { userId, ...DEFAULT_SETTINGS },
      });
    } catch (err) {
      // The session's user may no longer exist (e.g. a stale JWT cookie after a
      // database reset). Creating settings then hits a foreign-key violation
      // (P2003). Don't crash the Server Component render — return unsaved
      // defaults. The (app) layout guard redirects such stale sessions to
      // sign-out, so this fallback is only ever momentarily visible.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2003"
      ) {
        return { id: "", userId, ...DEFAULT_SETTINGS };
      }
      throw err;
    }
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
