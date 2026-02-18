import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { DataTableSearchParams } from "@/types/table.types";

export async function getVendors(userId: string, params: DataTableSearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const where: Prisma.VendorWhereInput = {
    userId,
    archived: params.archived === "true" ? undefined : false,
    ...(params.search && {
      OR: [
        { name: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { notes: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
      ],
    }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        _count: { select: { filaments: true, resins: true, paints: true } },
      },
    }),
    prisma.vendor.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getVendorById(id: string, userId: string) {
  return prisma.vendor.findFirst({
    where: { id, userId },
    include: {
      _count: { select: { filaments: true, resins: true, paints: true } },
    },
  });
}

export async function getVendorOptions(userId: string) {
  return prisma.vendor.findMany({
    where: { userId, archived: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
