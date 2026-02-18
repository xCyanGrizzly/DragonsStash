import { prisma } from "@/lib/prisma";

interface LowStockItem {
  id: string;
  name: string;
  type: "filament" | "resin" | "paint" | "supply";
  colorHex: string;
  remaining: number;
  total: number;
  percent: number;
}

interface RecentUsage {
  id: string;
  itemType: string;
  amount: number;
  unit: string;
  notes: string | null;
  createdAt: Date;
  itemName: string;
}

export interface DashboardStats {
  totalItems: number;
  inventoryValue: number;
  lowStockCount: number;
  recentActivityCount: number;
  lowStockItems: LowStockItem[];
  recentUsage: RecentUsage[];
}

export async function getDashboardStats(
  userId: string,
  lowStockThreshold: number
): Promise<DashboardStats> {
  const [filaments, resins, paints, supplies, usageLogs24h, recentLogs] = await Promise.all([
    prisma.filament.findMany({
      where: { userId, archived: false },
      select: {
        id: true,
        name: true,
        colorHex: true,
        spoolWeight: true,
        usedWeight: true,
        cost: true,
      },
    }),
    prisma.resin.findMany({
      where: { userId, archived: false },
      select: {
        id: true,
        name: true,
        colorHex: true,
        bottleSize: true,
        usedML: true,
        cost: true,
      },
    }),
    prisma.paint.findMany({
      where: { userId, archived: false },
      select: {
        id: true,
        name: true,
        colorHex: true,
        volumeML: true,
        usedML: true,
        cost: true,
      },
    }),
    prisma.supply.findMany({
      where: { userId, archived: false },
      select: {
        id: true,
        name: true,
        colorHex: true,
        totalAmount: true,
        usedAmount: true,
        cost: true,
      },
    }),
    prisma.usageLog.count({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.usageLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        filament: { select: { name: true } },
        resin: { select: { name: true } },
        paint: { select: { name: true } },
        supply: { select: { name: true } },
      },
    }),
  ]);

  const totalItems = filaments.length + resins.length + paints.length + supplies.length;

  const inventoryValue =
    filaments.reduce((sum: number, f: { cost: number | null }) => sum + (f.cost ?? 0), 0) +
    resins.reduce((sum: number, r: { cost: number | null }) => sum + (r.cost ?? 0), 0) +
    paints.reduce((sum: number, p: { cost: number | null }) => sum + (p.cost ?? 0), 0) +
    supplies.reduce((sum: number, s: { cost: number | null }) => sum + (s.cost ?? 0), 0);

  const lowStockItems: LowStockItem[] = [];

  for (const f of filaments) {
    const remaining = f.spoolWeight - f.usedWeight;
    const percent = f.spoolWeight > 0 ? (remaining / f.spoolWeight) * 100 : 0;
    if (percent <= lowStockThreshold && percent > 0) {
      lowStockItems.push({
        id: f.id,
        name: f.name,
        type: "filament",
        colorHex: f.colorHex,
        remaining,
        total: f.spoolWeight,
        percent,
      });
    }
  }

  for (const r of resins) {
    const remaining = r.bottleSize - r.usedML;
    const percent = r.bottleSize > 0 ? (remaining / r.bottleSize) * 100 : 0;
    if (percent <= lowStockThreshold && percent > 0) {
      lowStockItems.push({
        id: r.id,
        name: r.name,
        type: "resin",
        colorHex: r.colorHex,
        remaining,
        total: r.bottleSize,
        percent,
      });
    }
  }

  for (const p of paints) {
    const remaining = p.volumeML - p.usedML;
    const percent = p.volumeML > 0 ? (remaining / p.volumeML) * 100 : 0;
    if (percent <= lowStockThreshold && percent > 0) {
      lowStockItems.push({
        id: p.id,
        name: p.name,
        type: "paint",
        colorHex: p.colorHex,
        remaining,
        total: p.volumeML,
        percent,
      });
    }
  }

  for (const s of supplies) {
    const remaining = s.totalAmount - s.usedAmount;
    const percent = s.totalAmount > 0 ? (remaining / s.totalAmount) * 100 : 0;
    if (percent <= lowStockThreshold && percent > 0) {
      lowStockItems.push({
        id: s.id,
        name: s.name,
        type: "supply",
        colorHex: s.colorHex ?? "#6b7280",
        remaining,
        total: s.totalAmount,
        percent,
      });
    }
  }

  lowStockItems.sort((a, b) => a.percent - b.percent);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recentUsage: RecentUsage[] = recentLogs.map((log: any) => ({
    id: log.id,
    itemType: log.itemType,
    amount: log.amount,
    unit: log.unit,
    notes: log.notes,
    createdAt: log.createdAt,
    itemName:
      log.filament?.name ?? log.resin?.name ?? log.paint?.name ?? log.supply?.name ?? "Unknown",
  }));

  return {
    totalItems,
    inventoryValue,
    lowStockCount: lowStockItems.length,
    recentActivityCount: usageLogs24h,
    lowStockItems,
    recentUsage,
  };
}
