"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { MATERIALS } from "@/lib/constants";
import { getFilamentColumns, type FilamentRow } from "./filament-columns";
import { FilamentModal } from "./filament-modal";
import { deleteFilament, archiveFilament, logFilamentUsage } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DataTableFacetedFilter } from "@/components/shared/data-table-faceted-filter";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { UsageLogDialog } from "@/components/shared/usage-log-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface FilamentTableProps {
  data: FilamentRow[];
  pageCount: number;
  totalCount: number;
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  lowStockThreshold: number;
}

export function FilamentTable({
  data,
  pageCount,
  totalCount,
  vendors,
  locations,
  lowStockThreshold,
}: FilamentTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editFilament, setEditFilament] = useState<FilamentRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [usageFilament, setUsageFilament] = useState<FilamentRow | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

  // Filter state from URL
  const materialFilter = new Set(searchParams.getAll("material"));
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

  const columns = getFilamentColumns({
    onEdit: (filament) => {
      setEditFilament(filament);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archiveFilament(id);
        if (result.success) toast.success("Filament updated");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onLogUsage: (filament) => setUsageFilament(filament),
    lowStockThreshold,
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteFilament(deleteId);
      if (result.success) {
        toast.success("Filament deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const materialOptions = MATERIALS.map((m) => ({ label: m, value: m }));
  const vendorOptions = vendors.map((v) => ({ label: v.name, value: v.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <div className="space-y-4">
      <PageHeader title="Filaments" description="Manage your 3D printing filament inventory">
        <Button
          onClick={() => {
            setEditFilament(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Filament
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search filaments..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableFacetedFilter
          title="Material"
          options={materialOptions}
          selectedValues={materialFilter}
          onSelectionChange={(values) => updateFilters("material", values)}
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

      <DataTable table={table} emptyMessage="No filaments found. Add your first spool!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <FilamentModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditFilament(undefined);
        }}
        filament={
          editFilament
            ? {
                id: editFilament.id,
                name: editFilament.name,
                brand: editFilament.brand,
                material: editFilament.material,
                color: editFilament.color,
                colorHex: editFilament.colorHex,
                diameter: 1.75,
                spoolWeight: editFilament.spoolWeight,
                usedWeight: editFilament.usedWeight,
                emptySpoolWeight: 0,
                cost: editFilament.cost,
                purchaseDate: editFilament.purchaseDate,
                notes: null,
                vendorId: editFilament.vendor?.id ?? null,
                locationId: editFilament.location?.id ?? null,
              }
            : undefined
        }
        vendors={vendors}
        locations={locations}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Filament"
        description="This will permanently delete this filament spool and all its usage logs."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      {usageFilament && (
        <UsageLogDialog
          open={!!usageFilament}
          onOpenChange={(open) => !open && setUsageFilament(null)}
          itemName={usageFilament.name}
          unit="g"
          onSubmit={async (amount, notes) => {
            const result = await logFilamentUsage(usageFilament.id, { amount, notes });
            return result;
          }}
        />
      )}
    </div>
  );
}
