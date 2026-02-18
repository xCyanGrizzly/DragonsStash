import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getLocations } from "@/data/location.queries";
import { LocationTable } from "./_components/location-table";

interface LocationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LocationsPage({ searchParams }: LocationsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const { data, pageCount, totalCount } = await getLocations(session.user.id, {
    page: typeof params.page === "string" ? params.page : "1",
    perPage: typeof params.perPage === "string" ? params.perPage : "20",
    sort: typeof params.sort === "string" ? params.sort : undefined,
    order: typeof params.order === "string" ? (params.order as "asc" | "desc") : undefined,
    search: typeof params.search === "string" ? params.search : undefined,
  });

  return (
    <LocationTable
      data={JSON.parse(JSON.stringify(data))}
      pageCount={pageCount}
      totalCount={totalCount}
    />
  );
}
