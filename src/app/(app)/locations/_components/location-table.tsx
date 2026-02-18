"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { getLocationColumns, type LocationRow } from "./location-columns";
import { LocationModal } from "./location-modal";
import { deleteLocation, archiveLocation } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LocationTableProps {
  data: LocationRow[];
  pageCount: number;
  totalCount: number;
}

export function LocationTable({ data, pageCount, totalCount }: LocationTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editLocation, setEditLocation] = useState<LocationRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

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

  const columns = getLocationColumns({
    onEdit: (location) => {
      setEditLocation(location);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archiveLocation(id);
        if (result.success) toast.success("Location updated");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteLocation(deleteId);
      if (result.success) {
        toast.success("Location deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Locations" description="Manage your storage locations">
        <Button
          onClick={() => {
            setEditLocation(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Location
        </Button>
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search locations..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableViewOptions table={table} />
      </div>

      <DataTable table={table} emptyMessage="No locations found. Add your first location!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <LocationModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditLocation(undefined);
        }}
        location={editLocation}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Location"
        description="This will permanently delete this location. Items stored here will be unlinked."
        onConfirm={handleDelete}
        isLoading={isPending}
      />
    </div>
  );
}
