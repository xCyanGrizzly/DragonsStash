"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Archive, Trash2, FlaskConical } from "lucide-react";
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

export interface ResinRow {
  id: string;
  name: string;
  brand: string;
  resinType: string;
  color: string;
  colorHex: string;
  bottleSize: number;
  usedML: number;
  cost: number | null;
  purchaseDate: Date | null;
  notes: string | null;
  archived: boolean;
  vendor: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
}

interface ResinColumnsProps {
  onEdit: (resin: ResinRow) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onLogUsage: (resin: ResinRow) => void;
  lowStockThreshold: number;
}

export function getResinColumns({
  onEdit,
  onArchive,
  onDelete,
  onLogUsage,
  lowStockThreshold,
}: ResinColumnsProps): ColumnDef<ResinRow, unknown>[] {
  return [
    {
      id: "color",
      header: "",
      cell: ({ row }) => <ColorSwatch hex={row.original.colorHex} size="sm" />,
      enableHiding: false,
      size: 40,
    },
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => {
        const remaining = row.original.bottleSize - row.original.usedML;
        const status = getStockStatus(
          remaining,
          row.original.bottleSize,
          lowStockThreshold,
          row.original.archived
        );
        return (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            <StatusBadge variant={status} />
          </div>
        );
      },
      enableHiding: false,
    },
    {
      accessorKey: "brand",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Brand" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.brand}</span>
      ),
    },
    {
      accessorKey: "resinType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-xs">
          {row.original.resinType}
        </Badge>
      ),
    },
    {
      id: "remaining",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Remaining" />,
      cell: ({ row }) => {
        const remaining = row.original.bottleSize - row.original.usedML;
        const percent =
          row.original.bottleSize > 0
            ? (remaining / row.original.bottleSize) * 100
            : 0;
        const isLow = percent <= lowStockThreshold;
        return (
          <div className="flex items-center gap-2 min-w-[120px]">
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  isLow ? "bg-orange-500" : "bg-primary"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground w-16 text-right">
              {remaining.toFixed(0)} ml
            </span>
          </div>
        );
      },
    },
    {
      id: "location",
      header: "Location",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.location?.name ?? "\u2014"}
        </span>
      ),
    },
    {
      id: "vendor",
      header: "Vendor",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.vendor?.name ?? "\u2014"}
        </span>
      ),
    },
    {
      accessorKey: "cost",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Cost" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.cost != null ? `\u20AC${row.original.cost.toFixed(2)}` : "\u2014"}
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
              <FlaskConical className="mr-2 h-3.5 w-3.5" />
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
