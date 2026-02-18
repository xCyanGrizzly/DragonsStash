import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getPaints } from "@/data/paint.queries";
import { getVendorOptions } from "@/data/vendor.queries";
import { getLocationOptions } from "@/data/location.queries";
import { getUserSettings } from "@/data/settings.queries";
import { PaintTable } from "./_components/paint-table";

interface PaintsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaintsPage({ searchParams }: PaintsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const [paintsResult, vendors, locations, settings] = await Promise.all([
    getPaints(session.user.id, {
      page: typeof params.page === "string" ? params.page : "1",
      perPage: typeof params.perPage === "string" ? params.perPage : "20",
      sort: typeof params.sort === "string" ? params.sort : undefined,
      order: typeof params.order === "string" ? (params.order as "asc" | "desc") : undefined,
      search: typeof params.search === "string" ? params.search : undefined,
      finish: params.finish,
      vendor: params.vendor,
      location: params.location,
    }),
    getVendorOptions(session.user.id),
    getLocationOptions(session.user.id),
    getUserSettings(session.user.id),
  ]);

  return (
    <PaintTable
      data={JSON.parse(JSON.stringify(paintsResult.data))}
      pageCount={paintsResult.pageCount}
      totalCount={paintsResult.totalCount}
      vendors={vendors}
      locations={locations}
      lowStockThreshold={settings.lowStockThreshold}
    />
  );
}
