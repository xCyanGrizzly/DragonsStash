"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface SkippedRow {
  id: string;
  fileName: string;
  fileSize: string;
  reason: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
  errorMessage: string | null;
  sourceChannel: { id: string; title: string };
  isMultipart: boolean;
  partCount: number;
  createdAt: string;
}

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const REASON_LABELS: Record<SkippedRow["reason"], { label: string; variant: "default" | "destructive" | "outline" | "secondary" }> = {
  SIZE_LIMIT: { label: "Size Limit", variant: "secondary" },
  DOWNLOAD_FAILED: { label: "Download Failed", variant: "destructive" },
  EXTRACT_FAILED: { label: "Extract Failed", variant: "destructive" },
  UPLOAD_FAILED: { label: "Upload Failed", variant: "destructive" },
};

export function getSkippedColumns({
  onRetry,
}: {
  onRetry: (row: SkippedRow) => void;
}): ColumnDef<SkippedRow, unknown>[] {
  return [
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate max-w-[300px]">{row.original.fileName}</span>
          {row.original.isMultipart && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {row.original.partCount} parts
            </Badge>
          )}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "fileSize",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatBytes(row.original.fileSize)}
        </span>
      ),
    },
    {
      accessorKey: "reason",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
      cell: ({ row }) => {
        const { label, variant } = REASON_LABELS[row.original.reason];
        return <Badge variant={variant} className="text-[10px]">{label}</Badge>;
      },
    },
    {
      accessorKey: "errorMessage",
      header: "Error",
      cell: ({ row }) => {
        const msg = row.original.errorMessage;
        if (!msg) return <span className="text-sm text-muted-foreground">{"\u2014"}</span>;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-muted-foreground truncate max-w-[200px] block cursor-help">
                {msg}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <p className="text-xs break-all">{msg}</p>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "channel",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground truncate max-w-[160px] block">
          {row.original.sourceChannel.title}
        </span>
      ),
      accessorFn: (row) => row.sourceChannel.title,
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Skipped" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onRetry(row.original)}
          title="Retry this package"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      ),
      enableHiding: false,
    },
  ];
}
