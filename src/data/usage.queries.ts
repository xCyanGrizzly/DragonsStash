import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { DataTableSearchParams } from "@/types/table.types";

// ─── Item picker data ─────────────────────────────────

export interface PickerItem {
  id: string;
  name: string;
  type: "FILAMENT" | "RESIN" | "PAINT" | "SUPPLY";
  unit: string;
}

export async function getAllUserItems(userId: string): Promise<PickerItem[]> {
  const [filaments, resins, paints, supplies] = await Promise.all([
    prisma.filament.findMany({
      where: { userId, archived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.resin.findMany({
      where: { userId, archived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.paint.findMany({
      where: { userId, archived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.supply.findMany({
      where: { userId, archived: false },
      select: { id: true, name: true, unit: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return [
    ...filaments.map((f) => ({ id: f.id, name: f.name, type: "FILAMENT" as const, unit: "g" })),
    ...resins.map((r) => ({ id: r.id, name: r.name, type: "RESIN" as const, unit: "ml" })),
    ...paints.map((p) => ({ id: p.id, name: p.name, type: "PAINT" as const, unit: "ml" })),
    ...supplies.map((s) => ({ id: s.id, name: s.name, type: "SUPPLY" as const, unit: s.unit })),
  ];
}

// ─── Usage log history ────────────────────────────────

export interface UsageLogRow {
  id: string;
  itemType: string;
  itemName: string;
  amount: number;
  unit: string;
  notes: string | null;
  createdAt: Date;
}

interface UsageSearchParams extends DataTableSearchParams {
  itemType?: string | string[];
}

export async function getUsageLogs(userId: string, params: UsageSearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const itemTypes = Array.isArray(params.itemType)
    ? params.itemType
    : params.itemType
      ? [params.itemType]
      : [];

  const where: Prisma.UsageLogWhereInput = {
    userId,
    ...(itemTypes.length > 0 && { itemType: { in: itemTypes } }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [logs, totalCount] = await Promise.all([
    prisma.usageLog.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        filament: { select: { name: true } },
        resin: { select: { name: true } },
        paint: { select: { name: true } },
        supply: { select: { name: true } },
      },
    }),
    prisma.usageLog.count({ where }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: UsageLogRow[] = logs.map((log: any) => ({
    id: log.id,
    itemType: log.itemType,
    itemName:
      log.filament?.name ?? log.resin?.name ?? log.paint?.name ?? log.supply?.name ?? "Unknown",
    amount: log.amount,
    unit: log.unit,
    notes: log.notes,
    createdAt: log.createdAt,
  }));

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}
