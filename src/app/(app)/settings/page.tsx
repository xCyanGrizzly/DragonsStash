import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserSettings } from "@/data/settings.queries";
import { PageHeader } from "@/components/shared/page-header";
import { SettingsForm } from "./_components/settings-form";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const settings = await getUserSettings(session.user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your application preferences"
      />
      <div className="max-w-2xl">
        <SettingsForm
          settings={JSON.parse(JSON.stringify(settings))}
        />
      </div>
    </div>
  );
}
