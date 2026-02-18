import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getSupplies } from "@/data/supply.queries";
import { getVendorOptions } from "@/data/vendor.queries";
import { getLocationOptions } from "@/data/location.queries";
import { getUserSettings } from "@/data/settings.queries";
import { SupplyTable } from "./_components/supply-table";

interface SuppliesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SuppliesPage({ searchParams }: SuppliesPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [suppliesResult, vendors, locations, settings] = await Promise.all([
    getSupplies(session.user.id, {
      page: typeof params.page === "string" ? params.page : "1",
      perPage: typeof params.perPage === "string" ? params.perPage : "20",
      sort: typeof params.sort === "string" ? params.sort : undefined,
      order: typeof params.order === "string" ? (params.order as "asc" | "desc") : undefined,
      search: typeof params.search === "string" ? params.search : undefined,
      category: params.category,
      vendor: params.vendor,
      location: params.location,
    }),
    getVendorOptions(session.user.id),
    getLocationOptions(session.user.id),
    getUserSettings(session.user.id),
  ]);

  return (
    <SupplyTable
      data={JSON.parse(JSON.stringify(suppliesResult.data))}
      pageCount={suppliesResult.pageCount}
      totalCount={suppliesResult.totalCount}
      vendors={vendors}
      locations={locations}
      lowStockThreshold={settings.lowStockThreshold}
    />
  );
}
