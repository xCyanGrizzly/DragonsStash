import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getFilaments } from "@/data/filament.queries";
import { getVendorOptions } from "@/data/vendor.queries";
import { getLocationOptions } from "@/data/location.queries";
import { getUserSettings } from "@/data/settings.queries";
import type { DataTableSearchParams } from "@/types/table.types";
import { FilamentTable } from "./_components/filament-table";

interface Props {
  searchParams: Promise<DataTableSearchParams>;
}

export default async function FilamentsPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [result, vendors, locations, settings] = await Promise.all([
    getFilaments(session.user.id, params),
    getVendorOptions(session.user.id),
    getLocationOptions(session.user.id),
    getUserSettings(session.user.id),
  ]);

  return (
    <FilamentTable
      data={JSON.parse(JSON.stringify(result.data))}
      pageCount={result.pageCount}
      totalCount={result.totalCount}
      vendors={vendors}
      locations={locations}
      lowStockThreshold={settings.lowStockThreshold}
    />
  );
}
