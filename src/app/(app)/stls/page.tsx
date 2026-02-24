import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listPackages, searchPackages, getIngestionStatus } from "@/lib/telegram/queries";
import { StlTable } from "./_components/stl-table";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StlFilesPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;

  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const sort = (params.sort as string) ?? "indexedAt";
  const order = (params.order as "asc" | "desc") ?? "desc";
  const search = (params.search as string) ?? "";
  const creator = (params.creator as string) || undefined;

  // Fetch packages and ingestion status in parallel
  const [result, ingestionStatus] = await Promise.all([
    search
      ? searchPackages({
          query: search,
          page,
          limit: perPage,
          searchIn: "both",
        })
      : listPackages({
          page,
          limit: perPage,
          creator,
          sortBy: sort as "indexedAt" | "fileName" | "fileSize",
          order,
        }),
    getIngestionStatus(),
  ]);

  return (
    <StlTable
      data={result.items}
      pageCount={result.pagination.totalPages}
      totalCount={result.pagination.total}
      ingestionStatus={ingestionStatus}
    />
  );
}
