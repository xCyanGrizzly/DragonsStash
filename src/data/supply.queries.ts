import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { DataTableSearchParams } from "@/types/table.types";

interface SupplySearchParams extends DataTableSearchParams {
  category?: string | string[];
  vendor?: string | string[];
  location?: string | string[];
}

export async function getSupplies(userId: string, params: SupplySearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const categories = Array.isArray(params.category)
    ? params.category
    : params.category
      ? [params.category]
      : [];
  const vendorIds = Array.isArray(params.vendor)
    ? params.vendor
    : params.vendor
      ? [params.vendor]
      : [];
  const locationIds = Array.isArray(params.location)
    ? params.location
    : params.location
      ? [params.location]
      : [];

  const where: Prisma.SupplyWhereInput = {
    userId,
    archived: params.archived === "true" ? undefined : false,
    ...(params.search && {
      OR: [
        { name: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { brand: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { color: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
      ],
    }),
    ...(categories.length > 0 && { category: { in: categories } }),
    ...(vendorIds.length > 0 && { vendorId: { in: vendorIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.supply.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        vendor: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    }),
    prisma.supply.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getSupplyById(id: string, userId: string) {
  return prisma.supply.findFirst({
    where: { id, userId },
    include: {
      vendor: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      tags: { include: { tag: true } },
    },
  });
}
