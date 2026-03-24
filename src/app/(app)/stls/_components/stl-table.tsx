"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import { getPackageColumns, type PackageRow } from "./package-columns";
import { PackageFilesDrawer } from "./package-files-drawer";
import { IngestionStatus } from "./ingestion-status";
import { SkippedPackagesTab } from "./skipped-packages-tab";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { IngestionAccountStatus } from "@/lib/telegram/types";
import type { SkippedRow } from "./skipped-columns";
import { updatePackageCreator, updatePackageTags } from "../actions";

interface StlTableProps {
  data: PackageRow[];
  pageCount: number;
  totalCount: number;
  ingestionStatus: IngestionAccountStatus[];
  availableTags: string[];
  searchTerm: string;
  skippedData: SkippedRow[];
  skippedPageCount: number;
  skippedTotalCount: number;
}

export function StlTable({
  data,
  pageCount,
  totalCount,
  ingestionStatus,
  availableTags,
  searchTerm,
  skippedData,
  skippedPageCount,
  skippedTotalCount,
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

  const updateTagFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set("tag", value);
        params.set("page", "1");
      } else {
        params.delete("tag");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const activeTab = searchParams.get("tab") ?? "packages";

  const updateTab = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "packages") {
        params.delete("tab");
      } else {
        params.set("tab", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const columns = getPackageColumns({
    onViewFiles: (pkg) => setViewPkg(pkg),
    searchTerm,
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
    onSetTags: (pkg) => {
      const value = prompt(
        "Enter tags (comma-separated):",
        pkg.tags.join(", ")
      );
      if (value === null) return;
      const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      startTransition(async () => {
        const result = await updatePackageTags(pkg.id, tags);
        if (result.success) {
          toast.success(tags.length > 0 ? `Tags updated` : "Tags removed");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const activeTag = searchParams.get("tag") ?? "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="STL Files"
        description="Browse indexed archive packages from Telegram channels"
      >
        <IngestionStatus initialStatus={ingestionStatus} />
      </PageHeader>

      <Tabs value={activeTab} onValueChange={updateTab}>
        <TabsList>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="skipped" className="gap-1.5">
            Skipped / Failed
            {skippedTotalCount > 0 && (
              <Badge variant="secondary" className="text-[10px] ml-1">
                {skippedTotalCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="packages" className="space-y-4">
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
            {availableTags.length > 0 && (
              <Select value={activeTag || "all"} onValueChange={updateTagFilter}>
                <SelectTrigger className="w-[160px] h-9">
                  <SelectValue placeholder="All Tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tags</SelectItem>
                  {availableTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DataTableViewOptions table={table} />
          </div>

          <DataTable
            table={table}
            emptyMessage="No packages found. Archives will appear here after ingestion."
          />
          <DataTablePagination table={table} totalCount={totalCount} />
        </TabsContent>

        <TabsContent value="skipped">
          <SkippedPackagesTab
            data={skippedData}
            pageCount={skippedPageCount}
            totalCount={skippedTotalCount}
          />
        </TabsContent>
      </Tabs>

      <PackageFilesDrawer
        pkg={viewPkg}
        open={!!viewPkg}
        onOpenChange={(open) => {
          if (!open) setViewPkg(null);
        }}
        highlightTerm={searchTerm}
      />
    </div>
  );
}
