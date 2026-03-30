import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listDisplayItems, searchPackages, getIngestionStatus, getAllPackageTags, listSkippedPackages, countSkippedPackages, listUngroupedPackages, countUngroupedPackages } from "@/lib/telegram/queries";
import { StlTable } from "./_components/stl-table";
import type { DisplayItem, PackageListItem } from "@/lib/telegram/types";

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
  const tag = (params.tag as string) || undefined;
  const tab = (params.tab as string) ?? "packages";

  // Fetch packages, ingestion status, tags, and skipped count in parallel
  const [result, ingestionStatus, availableTags, skippedCount, ungroupedCount] = await Promise.all([
    search
      ? searchPackages({
          query: search,
          page,
          limit: perPage,
          searchIn: "both",
        })
      : listDisplayItems({
          page,
          limit: perPage,
          creator,
          tag,
          sortBy: sort as "indexedAt" | "fileName" | "fileSize",
          order,
        }),
    getIngestionStatus(),
    getAllPackageTags(),
    countSkippedPackages(),
    countUngroupedPackages(),
  ]);

  // For search results, wrap as DisplayItem[]; for non-search, already DisplayItem[]
  const displayItems: DisplayItem[] = search
    ? (result as { items: PackageListItem[] }).items.map((item) => ({ type: "package" as const, data: item }))
    : (result as { items: DisplayItem[] }).items;

  // Fetch skipped packages only if on that tab
  const skippedResult = tab === "skipped"
    ? await listSkippedPackages({ page, limit: perPage })
    : null;

  // Fetch ungrouped packages only if on that tab
  const ungroupedResult = tab === "ungrouped"
    ? await listUngroupedPackages({ page, limit: perPage })
    : null;

  return (
    <StlTable
      data={displayItems}
      pageCount={result.pagination.totalPages}
      totalCount={result.pagination.total}
      ingestionStatus={ingestionStatus}
      availableTags={availableTags}
      searchTerm={search}
      skippedData={skippedResult?.items ?? []}
      skippedPageCount={skippedResult?.pagination.totalPages ?? 0}
      skippedTotalCount={skippedCount}
      ungroupedData={ungroupedResult?.items ?? []}
      ungroupedPageCount={ungroupedResult?.pagination.totalPages ?? 0}
      ungroupedTotalCount={ungroupedCount}
    />
  );
}
