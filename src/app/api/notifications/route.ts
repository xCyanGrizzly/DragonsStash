import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getRecentNotifications,
  getUnreadNotificationCount,
} from "@/data/notification.queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [notifications, unreadCount] = await Promise.all([
    getRecentNotifications(30),
    getUnreadNotificationCount(),
  ]);

  const serialized = notifications.map((n) => ({
    ...n,
    createdAt: n.createdAt.toISOString(),
  }));

  return NextResponse.json({ notifications: serialized, unreadCount });
}
