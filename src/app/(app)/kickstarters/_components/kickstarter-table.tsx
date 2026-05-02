"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { useDataTable } from "@/hooks/use-data-table";
import { getKickstarterColumns, type KickstarterRow } from "./kickstarter-columns";
import { KickstarterModal } from "./kickstarter-modal";
import { PackageLinkerDialog } from "./package-linker-dialog";
import { deleteKickstarter, sendAllKickstarterPackages } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HostOption {
  id: string;
  name: string;
  _count: { kickstarters: number };
}

interface KickstarterTableProps {
  data: KickstarterRow[];
  pageCount: number;
  totalCount: number;
  hosts: HostOption[];
}

export function KickstarterTable({
  data,
  pageCount,
  totalCount,
  hosts,
}: KickstarterTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [modalOpen, setModalOpen] = useState(false);
  const [editKickstarter, setEditKickstarter] = useState<KickstarterRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<KickstarterRow | null>(null);

  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");

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

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set(key, value);
        params.set("page", "1");
      } else {
        params.delete(key);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const columns = getKickstarterColumns({
    onEdit: (kickstarter) => {
      setEditKickstarter(kickstarter);
      setModalOpen(true);
    },
    onDelete: (id) => setDeleteId(id),
    onLinkPackages: (kickstarter) => setLinkTarget(kickstarter),
    onSendAll: (kickstarter) => {
      startTransition(async () => {
        const result = await sendAllKickstarterPackages(kickstarter.id);
        if (result.success) {
          toast.success(`Queued ${result.data!.queued} package(s) for delivery`);
        } else {
          toast.error(result.error);
        }
      });
    },
  });

  const { table } = useDataTable({ data, columns, pageCount });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteKickstarter(deleteId);
      if (result.success) {
        toast.success("Kickstarter deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const activeDelivery = searchParams.get("delivery") ?? "";
  const activePayment = searchParams.get("payment") ?? "";
  const activeHost = searchParams.get("host") ?? "";

  return (
    <div className="space-y-4">
      <PageHeader title="Kickstarters" description="Track your crowdfunding campaigns and deliveries">
        <Button onClick={() => { setEditKickstarter(undefined); setModalOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" />
          Add Kickstarter
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search kickstarters..."
            value={searchValue}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={activeDelivery || "all"} onValueChange={(v) => updateFilter("delivery", v)}>
          <SelectTrigger className="w-[160px] h-9">
            <SelectValue placeholder="All Delivery" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Delivery</SelectItem>
            <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
            <SelectItem value="PARTIAL">Partial</SelectItem>
            <SelectItem value="DELIVERED">Delivered</SelectItem>
          </SelectContent>
        </Select>
        <Select value={activePayment || "all"} onValueChange={(v) => updateFilter("payment", v)}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue placeholder="All Payment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Payment</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
            <SelectItem value="UNPAID">Unpaid</SelectItem>
          </SelectContent>
        </Select>
        {hosts.length > 0 && (
          <Select value={activeHost || "all"} onValueChange={(v) => updateFilter("host", v)}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Hosts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Hosts</SelectItem>
              {hosts.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DataTableViewOptions table={table} />
      </div>

      <DataTable table={table} emptyMessage="No kickstarters found. Add your first campaign!" />
      <DataTablePagination table={table} totalCount={totalCount} />

      <KickstarterModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditKickstarter(undefined);
        }}
        hosts={hosts}
        kickstarter={editKickstarter}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Kickstarter"
        description="This will permanently delete this kickstarter and unlink any associated packages."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      {linkTarget && (
        <PackageLinkerDialog
          open={!!linkTarget}
          onOpenChange={(open) => !open && setLinkTarget(null)}
          kickstarterId={linkTarget.id}
          kickstarterName={linkTarget.name}
        />
      )}
    </div>
  );
}
