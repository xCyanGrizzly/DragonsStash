"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import { getSkippedColumns, type SkippedRow } from "./skipped-columns";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { Button } from "@/components/ui/button";
import { retrySkippedPackageAction, retryAllSkippedPackagesAction } from "../actions";

interface SkippedPackagesTabProps {
  data: SkippedRow[];
  pageCount: number;
  totalCount: number;
}

export function SkippedPackagesTab({
  data,
  pageCount,
  totalCount,
}: SkippedPackagesTabProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const columns = getSkippedColumns({
    onRetry: (row) => {
      startTransition(async () => {
        const result = await retrySkippedPackageAction(row.id);
        if (result.success) {
          toast.success(`"${row.fileName}" queued for retry`);
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
      {totalCount > 0 && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await retryAllSkippedPackagesAction();
                if (result.success) {
                  toast.success(`All ${totalCount} skipped packages queued for retry`);
                  router.refresh();
                } else {
                  toast.error(result.error);
                }
              });
            }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry All ({totalCount})
          </Button>
        </div>
      )}
      <DataTable
        table={table}
        emptyMessage="No skipped or failed packages."
      />
      <DataTablePagination table={table} totalCount={totalCount} />
    </div>
  );
}
