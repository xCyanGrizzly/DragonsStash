"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Archive, Trash2 } from "lucide-react";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface LocationRow {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: Date;
  _count: { filaments: number; resins: number; paints: number };
}

interface LocationColumnsProps {
  onEdit: (location: LocationRow) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

export function getLocationColumns({
  onEdit,
  onArchive,
  onDelete,
}: LocationColumnsProps): ColumnDef<LocationRow, unknown>[] {
  return [
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
      accessorKey: "description",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Description" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground truncate max-w-[300px] block">
          {row.original.description || "\u2014"}
        </span>
      ),
    },
    {
      id: "items",
      header: "Items",
      cell: ({ row }) => {
        const c = row.original._count;
        const total = c.filaments + c.resins + c.paints;
        return (
          <span className="text-sm text-muted-foreground">{total}</span>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
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
