"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { SUPPLY_CATEGORIES } from "@/lib/constants";
import { getSupplyColumns, type SupplyRow } from "./supply-columns";
import { SupplyModal } from "./supply-modal";
import { deleteSupply, archiveSupply, logSupplyUsage } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DataTableFacetedFilter } from "@/components/shared/data-table-faceted-filter";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { UsageLogDialog } from "@/components/shared/usage-log-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SupplyTableProps {
  data: SupplyRow[];
  pageCount: number;
  totalCount: number;
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  lowStockThreshold: number;
}

export function SupplyTable({
  data,
  pageCount,
  totalCount,
  vendors,
  locations,
  lowStockThreshold,
}: SupplyTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editSupply, setEditSupply] = useState<SupplyRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [usageSupply, setUsageSupply] = useState<SupplyRow | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

  const categoryFilter = new Set(searchParams.getAll("category"));
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

  const columns = getSupplyColumns({
    onEdit: (supply) => {
      setEditSupply(supply);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archiveSupply(id);
        if (result.success) toast.success("Supply updated");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onLogUsage: (supply) => setUsageSupply(supply),
    lowStockThreshold,
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteSupply(deleteId);
      if (result.success) {
        toast.success("Supply deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const categoryOptions = SUPPLY_CATEGORIES.map((c) => ({ label: c, value: c }));
  const vendorOptions = vendors.map((v) => ({ label: v.name, value: v.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <div className="space-y-4">
      <PageHeader title="Supplies" description="Manage your dice-making and crafting supplies">
        <Button
          onClick={() => {
            setEditSupply(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Supply
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search supplies..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableFacetedFilter
          title="Category"
          options={categoryOptions}
          selectedValues={categoryFilter}
          onSelectionChange={(values) => updateFilters("category", values)}
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

      <DataTable table={table} emptyMessage="No supplies found. Add your first supply!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <SupplyModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditSupply(undefined);
        }}
        supply={
          editSupply
            ? {
                id: editSupply.id,
                name: editSupply.name,
                brand: editSupply.brand,
                category: editSupply.category,
                color: editSupply.color,
                colorHex: editSupply.colorHex,
                totalAmount: editSupply.totalAmount,
                usedAmount: editSupply.usedAmount,
                unit: editSupply.unit,
                cost: editSupply.cost,
                purchaseDate: editSupply.purchaseDate,
                notes: editSupply.notes,
                vendorId: editSupply.vendor?.id ?? null,
                locationId: editSupply.location?.id ?? null,
              }
            : undefined
        }
        vendors={vendors}
        locations={locations}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Supply"
        description="This will permanently delete this supply and all its usage logs."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      {usageSupply && (
        <UsageLogDialog
          open={!!usageSupply}
          onOpenChange={(open) => !open && setUsageSupply(null)}
          itemName={usageSupply.name}
          unit={usageSupply.unit}
          onSubmit={async (amount, notes) => {
            const result = await logSupplyUsage(usageSupply.id, { amount, notes });
            return result;
          }}
        />
      )}
    </div>
  );
}
