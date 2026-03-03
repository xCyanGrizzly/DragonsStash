import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/telegram/bot/send/[id]
 * Poll the status of a bot send request.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const sendRequest = await prisma.botSendRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      error: true,
      requestedByUserId: true,
      createdAt: true,
      completedAt: true,
      package: { select: { id: true, fileName: true } },
      telegramLink: { select: { userId: true } },
    },
  });

  if (!sendRequest) {
    return NextResponse.json({ error: "Send request not found" }, { status: 404 });
  }

  // Users can only see their own requests unless admin
  const isOwner =
    sendRequest.requestedByUserId === session.user.id ||
    sendRequest.telegramLink.userId === session.user.id;

  if (!isOwner && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: sendRequest.id,
    status: sendRequest.status,
    error: sendRequest.error,
    packageId: sendRequest.package.id,
    fileName: sendRequest.package.fileName,
    createdAt: sendRequest.createdAt,
    completedAt: sendRequest.completedAt,
  });
}
