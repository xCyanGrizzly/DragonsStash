"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Archive, Trash2, Droplet } from "lucide-react";
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

export interface PaintRow {
  id: string;
  name: string;
  brand: string;
  line: string | null;
  color: string;
  colorHex: string;
  finish: string;
  volumeML: number;
  usedML: number;
  cost: number | null;
  purchaseDate: Date | null;
  notes: string | null;
  archived: boolean;
  vendor: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
}

interface PaintColumnsProps {
  onEdit: (paint: PaintRow) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onLogUsage: (paint: PaintRow) => void;
  lowStockThreshold: number;
}

export function getPaintColumns({
  onEdit,
  onArchive,
  onDelete,
  onLogUsage,
  lowStockThreshold,
}: PaintColumnsProps): ColumnDef<PaintRow, unknown>[] {
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
        const remaining = row.original.volumeML - row.original.usedML;
        const status = getStockStatus(
          remaining,
          row.original.volumeML,
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
        <div className="flex flex-col">
          <span className="text-sm">{row.original.brand}</span>
          {row.original.line && (
            <span className="text-xs text-muted-foreground">{row.original.line}</span>
          )}
        </div>
      ),
    },
    {
      accessorKey: "finish",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Finish" />,
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-xs">
          {row.original.finish}
        </Badge>
      ),
    },
    {
      id: "remaining",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Remaining" />,
      cell: ({ row }) => {
        const remaining = row.original.volumeML - row.original.usedML;
        const percent =
          row.original.volumeML > 0
            ? (remaining / row.original.volumeML) * 100
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
            <span className="text-xs text-muted-foreground w-14 text-right">
              {remaining.toFixed(1)} ml
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
              <Droplet className="mr-2 h-3.5 w-3.5" />
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
