"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Archive, Trash2, ExternalLink } from "lucide-react";
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

interface VendorRow {
  id: string;
  name: string;
  website: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: Date;
  _count: { filaments: number; resins: number; paints: number };
}

interface VendorColumnsProps {
  onEdit: (vendor: VendorRow) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

export function getVendorColumns({
  onEdit,
  onArchive,
  onDelete,
}: VendorColumnsProps): ColumnDef<VendorRow, unknown>[] {
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
      accessorKey: "website",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Website" />,
      cell: ({ row }) =>
        row.original.website ? (
          <a
            href={row.original.website}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {new URL(row.original.website).hostname}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "items",
      header: "Items",
      cell: ({ row }) => {
        const c = row.original._count;
        return (
          <span className="text-sm text-muted-foreground">
            {c.filaments + c.resins + c.paints}
          </span>
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
