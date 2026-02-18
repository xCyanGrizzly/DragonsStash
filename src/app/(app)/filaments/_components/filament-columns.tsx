"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Archive, Trash2, Plus } from "lucide-react";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { StatusBadge, getStockStatus } from "@/components/shared/status-badge";
import { ColorSwatch } from "@/components/shared/color-swatch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface FilamentRow {
  id: string;
  name: string;
  brand: string;
  material: string;
  color: string;
  colorHex: string;
  spoolWeight: number;
  usedWeight: number;
  cost: number | null;
  purchaseDate: Date | null;
  archived: boolean;
  vendor: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  tags: { tag: { id: string; name: string } }[];
}

interface FilamentColumnsProps {
  onEdit: (filament: FilamentRow) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onLogUsage: (filament: FilamentRow) => void;
  lowStockThreshold: number;
}

export function getFilamentColumns({
  onEdit,
  onArchive,
  onDelete,
  onLogUsage,
  lowStockThreshold,
}: FilamentColumnsProps): ColumnDef<FilamentRow, unknown>[] {
  return [
    {
      id: "colorPreview",
      header: "",
      cell: ({ row }) => <ColorSwatch hex={row.original.colorHex} size="sm" />,
      enableHiding: false,
      enableSorting: false,
      size: 40,
    },
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          {row.original.archived && <StatusBadge variant="archived" />}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "brand",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Brand" />,
      cell: ({ row }) => <span className="text-sm">{row.original.brand}</span>,
    },
    {
      accessorKey: "material",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Material" />,
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-[10px]">
          {row.original.material}
        </Badge>
      ),
    },
    {
      id: "remaining",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Remaining" />,
      cell: ({ row }) => {
        const remaining = row.original.spoolWeight - row.original.usedWeight;
        const percent = row.original.spoolWeight > 0
          ? Math.round((remaining / row.original.spoolWeight) * 100)
          : 0;
        const status = getStockStatus(remaining, row.original.spoolWeight, lowStockThreshold, row.original.archived);

        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${
                  status === "lowStock" || status === "empty"
                    ? "bg-orange-500"
                    : "bg-emerald-500"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
            <span className="text-sm text-muted-foreground">
              {Math.round(remaining)}g ({percent}%)
            </span>
            {(status === "lowStock" || status === "empty") && !row.original.archived && (
              <StatusBadge variant={status} />
            )}
          </div>
        );
      },
      accessorFn: (row) => row.spoolWeight - row.usedWeight,
    },
    {
      id: "location",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Location" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.location?.name || "—"}
        </span>
      ),
      accessorFn: (row) => row.location?.name,
    },
    {
      id: "vendor",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Vendor" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.vendor?.name || "—"}
        </span>
      ),
      accessorFn: (row) => row.vendor?.name,
    },
    {
      accessorKey: "cost",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Cost" />,
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.cost != null ? `$${row.original.cost.toFixed(2)}` : "—"}
        </span>
      ),
    },
    {
      accessorKey: "purchaseDate",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Purchased" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.purchaseDate
            ? new Date(row.original.purchaseDate).toLocaleDateString()
            : "—"}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(row.original)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onLogUsage(row.original)}>
              <Plus className="mr-2 h-3.5 w-3.5" />
              Log Usage
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onArchive(row.original.id)}>
              <Archive className="mr-2 h-3.5 w-3.5" />
              {row.original.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(row.original.id)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      enableHiding: false,
    },
  ];
}
