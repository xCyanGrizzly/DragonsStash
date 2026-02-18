"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { useDebounce } from "@/hooks/use-debounce";
import { getVendorColumns } from "./vendor-columns";
import { VendorModal } from "./vendor-modal";
import { deleteVendor, archiveVendor } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface VendorRow {
  id: string;
  name: string;
  website: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: Date;
  _count: { filaments: number; resins: number; paints: number };
}

interface VendorTableProps {
  data: VendorRow[];
  pageCount: number;
  totalCount: number;
}

export function VendorTable({ data, pageCount, totalCount }: VendorTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editVendor, setEditVendor] = useState<VendorRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");
  const _debouncedSearch = useDebounce(searchValue, 300);

  // Update URL when search changes
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

  const columns = getVendorColumns({
    onEdit: (vendor) => {
      setEditVendor(vendor);
      setModalOpen(true);
    },
    onArchive: (id) => {
      startTransition(async () => {
        const result = await archiveVendor(id);
        if (result.success) {
          toast.success("Vendor updated");
        } else {
          toast.error(result.error);
        }
      });
    },
    onDelete: (id) => setDeleteId(id),
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteVendor(deleteId);
      if (result.success) {
        toast.success("Vendor deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Vendors" description="Manage your inventory vendors">
        <Button onClick={() => { setEditVendor(undefined); setModalOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" />
          Add Vendor
        </Button>
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search vendors..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DataTableViewOptions table={table} />
      </div>

      <DataTable table={table} emptyMessage="No vendors found. Add your first vendor!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <VendorModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditVendor(undefined);
        }}
        vendor={editVendor}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Vendor"
        description="This will permanently delete this vendor. Items linked to this vendor will be unlinked."
        onConfirm={handleDelete}
        isLoading={isPending}
      />
    </div>
  );
}
