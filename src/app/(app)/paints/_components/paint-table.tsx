"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { PAINT_FINISHES } from "@/lib/constants";
import { getPaintColumns, type PaintRow } from "./paint-columns";
import { PaintModal } from "./paint-modal";
import { deletePaint, archivePaint, logPaintUsage } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DataTableFacetedFilter } from "@/components/shared/data-table-faceted-filter";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { UsageLogDialog } from "@/components/shared/usage-log-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface PaintTableProps {
  data: PaintRow[];
  pageCount: number;
  totalCount: number;
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  lowStockThreshold: number;
}

export function PaintTable({
  data,
  pageCount,
  totalCount,
  vendors,
  locations,
  lowStockThreshold,
}: PaintTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editPaint, setEditPaint] = useState<PaintRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [usagePaint, setUsagePaint] = useState<PaintRow | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

  const finishFilter = new Set(searchParams.getAll("finish"));
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

  const columns = getPaintColumns({
    onEdit: (paint) => {
      setEditPaint(paint);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archivePaint(id);
        if (result.success) toast.success("Paint updated");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onLogUsage: (paint) => setUsagePaint(paint),
    lowStockThreshold,
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deletePaint(deleteId);
      if (result.success) {
        toast.success("Paint deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const finishOptions = PAINT_FINISHES.map((f) => ({ label: f, value: f }));
  const vendorOptions = vendors.map((v) => ({ label: v.name, value: v.id }));
  const locationOptions = locations.map((l) => ({ label: l.name, value: l.id }));

  return (
    <div className="space-y-4">
      <PageHeader title="Paints" description="Manage your miniature paint collection">
        <Button
          onClick={() => {
            setEditPaint(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Paint
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search paints..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableFacetedFilter
          title="Finish"
          options={finishOptions}
          selectedValues={finishFilter}
          onSelectionChange={(values) => updateFilters("finish", values)}
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

      <DataTable table={table} emptyMessage="No paints found. Add your first paint!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <PaintModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditPaint(undefined);
        }}
        paint={
          editPaint
            ? {
                id: editPaint.id,
                name: editPaint.name,
                brand: editPaint.brand,
                line: editPaint.line,
                color: editPaint.color,
                colorHex: editPaint.colorHex,
                finish: editPaint.finish,
                volumeML: editPaint.volumeML,
                usedML: editPaint.usedML,
                cost: editPaint.cost,
                purchaseDate: editPaint.purchaseDate,
                notes: editPaint.notes,
                vendorId: editPaint.vendor?.id ?? null,
                locationId: editPaint.location?.id ?? null,
              }
            : undefined
        }
        vendors={vendors}
        locations={locations}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Paint"
        description="This will permanently delete this paint and all its usage logs."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      {usagePaint && (
        <UsageLogDialog
          open={!!usagePaint}
          onOpenChange={(open) => !open && setUsagePaint(null)}
          itemName={usagePaint.name}
          unit="ml"
          onSubmit={async (amount, notes) => {
            const result = await logPaintUsage(usagePaint.id, { amount, notes });
            return result;
          }}
        />
      )}
    </div>
  );
}
