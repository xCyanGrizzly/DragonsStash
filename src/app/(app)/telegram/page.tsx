import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listAccounts, listChannels } from "@/lib/telegram/admin-queries";
import { TelegramAdmin } from "./_components/telegram-admin";

export default async function TelegramPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/dashboard");

  const [accounts, channels] = await Promise.all([
    listAccounts(),
    listChannels(),
  ]);

  return <TelegramAdmin accounts={accounts} channels={channels} />;
}
