import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  clearAllNotifications,
} from "@/data/notification.queries";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const id = body.id as string | undefined;
  const action = (body.action as string) ?? "read";

  if (action === "dismiss" && id) {
    await dismissNotification(id);
  } else if (action === "clear") {
    await clearAllNotifications();
  } else if (id) {
    await markNotificationRead(id);
  } else {
    await markAllNotificationsRead();
  }

  return NextResponse.json({ success: true });
}
