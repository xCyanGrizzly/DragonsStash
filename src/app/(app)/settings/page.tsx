import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserSettings } from "@/data/settings.queries";
import { PageHeader } from "@/components/shared/page-header";
import { SettingsForm } from "./_components/settings-form";
import { TelegramLinkCard } from "./_components/telegram-link-card";
import { prisma } from "@/lib/prisma";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [settings, telegramLink] = await Promise.all([
    getUserSettings(session.user.id),
    prisma.telegramLink.findUnique({
      where: { userId: session.user.id },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your application preferences"
      />
      <div className="max-w-2xl space-y-6">
        <SettingsForm
          settings={JSON.parse(JSON.stringify(settings))}
        />
        <TelegramLinkCard
          linked={!!telegramLink}
          telegramName={telegramLink?.telegramName ?? null}
          telegramUserId={telegramLink?.telegramUserId?.toString() ?? null}
          linkedAt={telegramLink?.createdAt?.toISOString() ?? null}
          botUsername={process.env.BOT_USERNAME ?? null}
        />
      </div>
    </div>
  );
}
