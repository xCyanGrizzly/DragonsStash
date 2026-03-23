import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { DataTableSearchParams } from "@/types/table.types";

interface KickstarterSearchParams extends DataTableSearchParams {
  delivery?: string;
  payment?: string;
  host?: string;
}

export async function getKickstarters(
  userId: string,
  params: KickstarterSearchParams
) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const skip = (page - 1) * perPage;

  const where: Prisma.KickstarterWhereInput = {
    userId,
    ...(params.search && {
      OR: [
        {
          name: {
            contains: params.search,
            mode: "insensitive" as Prisma.QueryMode,
          },
        },
        {
          notes: {
            contains: params.search,
            mode: "insensitive" as Prisma.QueryMode,
          },
        },
      ],
    }),
    ...(params.delivery && {
      deliveryStatus: params.delivery as Prisma.EnumDeliveryStatusFilter,
    }),
    ...(params.payment && {
      paymentStatus: params.payment as Prisma.EnumPaymentStatusFilter,
    }),
    ...(params.host && { hostId: params.host }),
  };

  const sortField = params.sort || "createdAt";
  const sortOrder = params.order || "desc";

  const [data, totalCount] = await Promise.all([
    prisma.kickstarter.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: perPage,
      include: {
        host: { select: { id: true, name: true } },
        _count: { select: { packages: true } },
      },
    }),
    prisma.kickstarter.count({ where }),
  ]);

  return {
    data,
    pageCount: Math.ceil(totalCount / perPage),
    totalCount,
  };
}

export async function getKickstarterById(id: string, userId: string) {
  return prisma.kickstarter.findFirst({
    where: { id, userId },
    include: {
      host: { select: { id: true, name: true } },
      packages: {
        include: {
          package: {
            select: {
              id: true,
              fileName: true,
              fileSize: true,
              archiveType: true,
              creator: true,
            },
          },
        },
      },
    },
  });
}

export async function getKickstarterHosts() {
  return prisma.kickstarterHost.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { kickstarters: true } } },
  });
}
