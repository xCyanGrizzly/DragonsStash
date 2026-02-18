import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getVendors } from "@/data/vendor.queries";
import type { DataTableSearchParams } from "@/types/table.types";
import { VendorTable } from "./_components/vendor-table";

interface Props {
  searchParams: Promise<DataTableSearchParams>;
}

export default async function VendorsPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const { data, pageCount, totalCount } = await getVendors(session.user.id, params);

  return <VendorTable data={data} pageCount={pageCount} totalCount={totalCount} />;
}
