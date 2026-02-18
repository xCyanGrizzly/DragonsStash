"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { RESIN_TYPES } from "@/lib/constants";
import { getResinColumns, type ResinRow } from "./resin-columns";
import { ResinModal } from "./resin-modal";
import { deleteResin, archiveResin, logResinUsage } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DataTableFacetedFilter } from "@/components/shared/data-table-faceted-filter";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { UsageLogDialog } from "@/components/shared/usage-log-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ResinTableProps {
  data: ResinRow[];
  pageCount: number;
  totalCount: number;
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  lowStockThreshold: number;
}

export function ResinTable({
  data,
  pageCount,
  totalCount,
  vendors,
  locations,
  lowStockThreshold,
}: ResinTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editResin, setEditResin] = useState<ResinRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [usageResin, setUsageResin] = useState<ResinRow | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

  const resinTypeFilter = new Set(searchParams.getAll("resinType"));
  const vendorFilter = new Set(searchParams.getAll("vendor"));
  const locationFilter = new Set(searchParams.getAll("location"));

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

  const updateSearch = (value: string) => {
    setSearchValue(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("search", value);
      params.set("page", "1");
    } else {
      params.delete("search");
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const columns = getResinColumns({
    onEdit: (resin) => {
      setEditResin(resin);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archiveResin(id);
        if (result.success) toast.success("Resin updated");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onLogUsage: (resin) => setUsageResin(resin),
    lowStockThreshold,
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteResin(deleteId);
      if (result.success) {
        toast.success("Resin deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const resinTypeOptions = RESIN_TYPES.map((t) => ({ label: t, value: t }));
  const vendorOptions = vendors.map((v) => ({ label: v.name, value: v.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <div className="space-y-4">
      <PageHeader title="Resins" description="Manage your SLA resin inventory">
        <Button
          onClick={() => {
            setEditResin(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Resin
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search resins..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableFacetedFilter
          title="Type"
          options={resinTypeOptions}
          selectedValues={resinTypeFilter}
          onSelectionChange={(values) => updateFilters("resinType", values)}
        />
        <DataTableFacetedFilter
          title="Vendor"
          options={vendorOptions}
          selectedValues={vendorFilter}
          onSelectionChange={(values) => updateFilters("vendor", values)}
        />
        <DataTableFacetedFilter
          title="Location"
          options={locationOptions}
          selectedValues={locationFilter}
          onSelectionChange={(values) => updateFilters("location", values)}
        />
        <DataTableViewOptions table={table} />
      </div>

      <DataTable table={table} emptyMessage="No resins found. Add your first bottle!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <ResinModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditResin(undefined);
        }}
        resin={
          editResin
            ? {
                id: editResin.id,
                name: editResin.name,
                brand: editResin.brand,
                resinType: editResin.resinType,
                color: editResin.color,
                colorHex: editResin.colorHex,
                bottleSize: editResin.bottleSize,
                usedML: editResin.usedML,
                cost: editResin.cost,
                purchaseDate: editResin.purchaseDate,
                notes: editResin.notes,
                vendorId: editResin.vendor?.id ?? null,
                locationId: editResin.location?.id ?? null,
              }
            : undefined
        }
        vendors={vendors}
        locations={locations}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Resin"
        description="This will permanently delete this resin bottle and all its usage logs."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      {usageResin && (
        <UsageLogDialog
          open={!!usageResin}
          onOpenChange={(open) => !open && setUsageResin(null)}
          itemName={usageResin.name}
          unit="ml"
          onSubmit={async (amount, notes) => {
            const result = await logResinUsage(usageResin.id, { amount, notes });
            return result;
          }}
        />
      )}
    </div>
  );
}
