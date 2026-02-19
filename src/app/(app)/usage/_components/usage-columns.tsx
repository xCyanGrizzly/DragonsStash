"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import type { UsageLogRow } from "@/data/usage.queries";

export function getUsageColumns(): ColumnDef<UsageLogRow, unknown>[] {
  return [
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Date" />,
      cell: ({ row }) => {
        const date = new Date(row.original.createdAt);
        return (
          <div className="text-sm">
            <p>{date.toLocaleDateString()}</p>
            <p className="text-xs text-muted-foreground">{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
        );
      },
      size: 130,
    },
    {
      accessorKey: "itemType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="text-[10px]">
          {row.original.itemType}
        </Badge>
      ),
      size: 100,
    },
    {
      accessorKey: "itemName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Item" />,
      cell: ({ row }) => (
        <p className="text-sm font-medium truncate max-w-[200px]">{row.original.itemName}</p>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "amount",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
      cell: ({ row }) => (
        <span className="text-sm font-medium">
          -{row.original.amount}{row.original.unit}
        </span>
      ),
      size: 100,
    },
    {
      accessorKey: "notes",
      header: "Notes",
      cell: ({ row }) => (
        <p className="text-sm text-muted-foreground truncate max-w-[250px]">
          {row.original.notes || "\u2014"}
        </p>
      ),
      enableSorting: false,
    },
  ];
}
