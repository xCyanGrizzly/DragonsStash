import { prisma } from "@/lib/prisma";

export async function getUnreadNotificationCount(): Promise<number> {
  return prisma.systemNotification.count({
    where: { isRead: false },
  });
}

export async function getRecentNotifications(limit = 20) {
  return prisma.systemNotification.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      type: true,
      severity: true,
      title: true,
      message: true,
      isRead: true,
      createdAt: true,
    },
  });
}

export async function markNotificationRead(id: string) {
  return prisma.systemNotification.update({
    where: { id },
    data: { isRead: true },
  });
}

export async function markAllNotificationsRead() {
  return prisma.systemNotification.updateMany({
    where: { isRead: false },
    data: { isRead: true },
  });
}

export async function dismissNotification(id: string) {
  return prisma.systemNotification.delete({ where: { id } });
}

export async function clearAllNotifications() {
  return prisma.systemNotification.deleteMany({});
}
