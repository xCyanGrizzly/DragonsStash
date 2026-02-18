import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import type { DataTableSearchParams } from "@/types/table.types";

interface FilamentSearchParams extends DataTableSearchParams {
  material?: string | string[];
  vendor?: string | string[];
  location?: string | string[];
}

export async function getFilaments(userId: string, params: FilamentSearchParams) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const materials = Array.isArray(params.material)
    ? params.material
    : params.material
      ? [params.material]
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

  const where: Prisma.FilamentWhereInput = {
    userId,
    archived: params.archived === "true" ? undefined : false,
    ...(params.search && {
      OR: [
        { name: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { brand: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
        { color: { contains: params.search, mode: "insensitive" as Prisma.QueryMode } },
      ],
    }),
    ...(materials.length > 0 && { material: { in: materials } }),
    ...(vendorIds.length > 0 && { vendorId: { in: vendorIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.filament.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        vendor: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        tags: { include: { tag: { select: { id: true, name: true } } } },
      },
    }),
    prisma.filament.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getFilamentById(id: string, userId: string) {
  return prisma.filament.findFirst({
    where: { id, userId },
    include: {
      vendor: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      tags: { include: { tag: true } },
    },
  });
}
