import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/shared/page-header";
import { getInviteCodes } from "./actions";
import { InviteManager } from "./_components/invite-manager";

export default async function InvitesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "ADMIN") redirect("/dashboard");

  const inviteCodes = await getInviteCodes();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invite Codes"
        description="Manage invite codes for new user registration"
      />
      <InviteManager
        inviteCodes={JSON.parse(JSON.stringify(inviteCodes))}
        appUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
      />
    </div>
  );
}
