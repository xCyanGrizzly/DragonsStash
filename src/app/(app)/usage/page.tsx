import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUsageLogs, getAllUserItems } from "@/data/usage.queries";
import type { DataTableSearchParams } from "@/types/table.types";
import { UsageTable } from "./_components/usage-table";

interface Props {
  searchParams: Promise<DataTableSearchParams>;
}

export default async function UsagePage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [result, items] = await Promise.all([
    getUsageLogs(session.user.id, params),
    getAllUserItems(session.user.id),
  ]);

  return (
    <UsageTable
      data={JSON.parse(JSON.stringify(result.data))}
      pageCount={result.pageCount}
      totalCount={result.totalCount}
      items={items}
    />
  );
}
