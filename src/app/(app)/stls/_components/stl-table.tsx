"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, FileBox } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import { getPackageColumns, type PackageRow } from "./package-columns";
import { PackageFilesDrawer } from "./package-files-drawer";
import { IngestionStatus } from "./ingestion-status";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import type { IngestionAccountStatus } from "@/lib/telegram/types";
import { updatePackageCreator } from "../actions";

interface StlTableProps {
  data: PackageRow[];
  pageCount: number;
  totalCount: number;
  ingestionStatus: IngestionAccountStatus[];
}

export function StlTable({
  data,
  pageCount,
  totalCount,
  ingestionStatus,
}: StlTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");
  const [viewPkg, setViewPkg] = useState<PackageRow | null>(null);
  const [, startTransition] = useTransition();

  const updateSearch = useCallback(
    (value: string) => {
      setSearchValue(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("search", value);
        params.set("page", "1");
      } else {
        params.delete("search");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const columns = getPackageColumns({
    onViewFiles: (pkg) => setViewPkg(pkg),
    onSetCreator: (pkg) => {
      const value = prompt("Enter creator name:", pkg.creator ?? "");
      if (value === null) return;
      startTransition(async () => {
        const result = await updatePackageCreator(pkg.id, value || null);
        if (result.success) {
          toast.success(value ? `Creator set to "${value}"` : "Creator removed");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
  });

  const { table } = useDataTable({ data, columns, pageCount });

  return (
    <div className="space-y-4">
      <PageHeader
        title="STL Files"
        description="Browse indexed archive packages from Telegram channels"
      >
        <IngestionStatus initialStatus={ingestionStatus} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search packages or files..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableViewOptions table={table} />
      </div>

      <DataTable
        table={table}
        emptyMessage="No packages found. Archives will appear here after ingestion."
      />
      <DataTablePagination table={table} totalCount={totalCount} />

      <PackageFilesDrawer
        pkg={viewPkg}
        open={!!viewPkg}
        onOpenChange={(open) => {
          if (!open) setViewPkg(null);
        }}
      />
    </div>
  );
}
