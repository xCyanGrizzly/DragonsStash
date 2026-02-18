import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getResins } from "@/data/resin.queries";
import { getVendorOptions } from "@/data/vendor.queries";
import { getLocationOptions } from "@/data/location.queries";
import { getUserSettings } from "@/data/settings.queries";
import { ResinTable } from "./_components/resin-table";

interface ResinsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResinsPage({ searchParams }: ResinsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [resinsResult, vendors, locations, settings] = await Promise.all([
    getResins(session.user.id, {
      page: typeof params.page === "string" ? params.page : "1",
      perPage: typeof params.perPage === "string" ? params.perPage : "20",
      sort: typeof params.sort === "string" ? params.sort : undefined,
      order: typeof params.order === "string" ? (params.order as "asc" | "desc") : undefined,
      search: typeof params.search === "string" ? params.search : undefined,
      resinType: params.resinType,
      vendor: params.vendor,
      location: params.location,
    }),
    getVendorOptions(session.user.id),
    getLocationOptions(session.user.id),
    getUserSettings(session.user.id),
  ]);

  return (
    <ResinTable
      data={JSON.parse(JSON.stringify(resinsResult.data))}
      pageCount={resinsResult.pageCount}
      totalCount={resinsResult.totalCount}
      vendors={vendors}
      locations={locations}
      lowStockThreshold={settings.lowStockThreshold}
    />
  );
}
