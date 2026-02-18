import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { DataTableSearchParams } from "@/types/table.types";

interface ResinSearchParams extends DataTableSearchParams {
  resinType?: string | string[];
  vendor?: string | string[];
  location?: string | string[];
}

export async function getResins(userId: string, params: ResinSearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const resinTypes = Array.isArray(params.resinType)
    ? params.resinType
    : params.resinType
      ? [params.resinType]
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

  const where: Prisma.ResinWhereInput = {
    userId,
    archived: params.archived === "true" ? undefined : false,
    ...(params.search && {
      OR: [
        { name: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { brand: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { color: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
      ],
    }),
    ...(resinTypes.length > 0 && { resinType: { in: resinTypes } }),
    ...(vendorIds.length > 0 && { vendorId: { in: vendorIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.resin.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        vendor: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    }),
    prisma.resin.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getResinById(id: string, userId: string) {
  return prisma.resin.findFirst({
    where: { id, userId },
    include: {
      vendor: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      tags: { include: { tag: true } },
    },
  });
}
