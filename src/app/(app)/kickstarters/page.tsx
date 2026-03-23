import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getKickstarters, getKickstarterHosts } from "@/data/kickstarter.queries";
import type { DataTableSearchParams } from "@/types/table.types";
import { KickstarterTable } from "./_components/kickstarter-table";

interface Props {
  searchParams: Promise<DataTableSearchParams & { delivery?: string; payment?: string; host?: string }>;
}

export default async function KickstartersPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [{ data, pageCount, totalCount }, hosts] = await Promise.all([
    getKickstarters(session.user.id, params),
    getKickstarterHosts(),
  ]);

  return (
    <KickstarterTable
      data={data}
      pageCount={pageCount}
      totalCount={totalCount}
      hosts={hosts}
    />
  );
}
