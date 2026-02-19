"use client";

import { useState, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import { getUsageColumns } from "./usage-columns";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableFacetedFilter } from "@/components/shared/data-table-faceted-filter";
import { QuickUsageDialog } from "@/components/shared/quick-usage-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import type { UsageLogRow } from "@/data/usage.queries";
import type { PickerItem } from "@/data/usage.queries";

const ITEM_TYPE_OPTIONS = [
  { label: "Filament", value: "FILAMENT" },
  { label: "Resin", value: "RESIN" },
  { label: "Paint", value: "PAINT" },
  { label: "Supply", value: "SUPPLY" },
];

interface UsageTableProps {
  data: UsageLogRow[];
  pageCount: number;
  totalCount: number;
  items: PickerItem[];
}

export function UsageTable({ data, pageCount, totalCount, items }: UsageTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(false);

  const itemTypeFilter = new Set(searchParams.getAll("itemType"));

  const updateFilters = useCallback(
    (key: string, values: Set<string>) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(key);
      values.forEach((v) => params.append(key, v));
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const columns = getUsageColumns();
  const { table } = useDataTable({ data, columns, pageCount });

  return (
    <div className="space-y-4">
      <PageHeader title="Usage History" description="Track material consumption across all items">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Log Usage
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <DataTableFacetedFilter
          title="Item Type"
          options={ITEM_TYPE_OPTIONS}
          selectedValues={itemTypeFilter}
          onSelectionChange={(values) => updateFilters("itemType", values)}
        />
      </div>

      <DataTable table={table} emptyMessage="No usage logged yet. Start tracking your consumption!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <QuickUsageDialog open={dialogOpen} onOpenChange={setDialogOpen} items={items} />
    </div>
  );
}
