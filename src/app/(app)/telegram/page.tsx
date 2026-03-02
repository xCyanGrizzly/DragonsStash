import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listAccounts, listChannels, getGlobalDestination } from "@/lib/telegram/admin-queries";
import { getIngestionStatus } from "@/lib/telegram/queries";
import { TelegramAdmin } from "./_components/telegram-admin";

export default async function TelegramPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/dashboard");

  const [accounts, channels, ingestionStatus, globalDestination] = await Promise.all([
    listAccounts(),
    listChannels(),
    getIngestionStatus(),
    getGlobalDestination(),
  ]);

  return (
    <TelegramAdmin
      accounts={accounts}
      channels={channels}
      ingestionStatus={ingestionStatus}
      globalDestination={globalDestination}
    />
  );
}
