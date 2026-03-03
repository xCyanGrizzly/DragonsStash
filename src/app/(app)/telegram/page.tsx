import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listAccounts, listChannels, getGlobalDestination } from "@/lib/telegram/admin-queries";
import { getIngestionStatus } from "@/lib/telegram/queries";
import { prisma } from "@/lib/prisma";
import { TelegramAdmin } from "./_components/telegram-admin";

export default async function TelegramPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/dashboard");

  const [accounts, channels, ingestionStatus, globalDestination, sendHistory] = await Promise.all([
    listAccounts(),
    listChannels(),
    getIngestionStatus(),
    getGlobalDestination(),
    prisma.botSendRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        package: { select: { fileName: true } },
        telegramLink: { select: { telegramName: true } },
      },
    }),
  ]);

  const serializedHistory = sendHistory.map((r) => ({
    id: r.id,
    packageName: r.package.fileName,
    recipientName: r.telegramLink.telegramName,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  }));

  return (
    <TelegramAdmin
      accounts={accounts}
      channels={channels}
      ingestionStatus={ingestionStatus}
      globalDestination={globalDestination}
      sendHistory={serializedHistory}
    />
  );
}
