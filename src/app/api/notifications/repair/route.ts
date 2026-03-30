import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const notificationId = body.notificationId as string;
  if (!notificationId) {
    return NextResponse.json({ error: "notificationId required" }, { status: 400 });
  }

  const notification = await prisma.systemNotification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }

  const context = notification.context as Record<string, unknown> | null;
  const packageId = context?.packageId as string | undefined;

  if (!packageId) {
    return NextResponse.json({ error: "Notification has no associated package" }, { status: 400 });
  }

  // Import and call the repair action
  const { repairPackageAction } = await import("@/app/(app)/stls/actions");
  const result = await repairPackageAction(packageId);

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
