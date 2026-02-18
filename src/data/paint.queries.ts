import { prisma } from "@/lib/prisma";
import { Prisma } from "../generated/prisma";
import type { DataTableSearchParams } from "@/types/table.types";

interface PaintSearchParams extends DataTableSearchParams {
  finish?: string | string[];
  vendor?: string | string[];
  location?: string | string[];
}

export async function getPaints(userId: string, params: PaintSearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const finishes = Array.isArray(params.finish)
    ? params.finish
    : params.finish
      ? [params.finish]
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

  const where: Prisma.PaintWhereInput = {
    userId,
    archived: params.archived === "true" ? undefined : false,
    ...(params.search && {
      OR: [
        { name: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { brand: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { color: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { line: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
      ],
    }),
    ...(finishes.length > 0 && { finish: { in: finishes } }),
    ...(vendorIds.length > 0 && { vendorId: { in: vendorIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.paint.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        vendor: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    }),
    prisma.paint.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getPaintById(id: string, userId: string) {
  return prisma.paint.findFirst({
    where: { id, userId },
    include: {
      vendor: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      tags: { include: { tag: true } },
    },
  });
}
