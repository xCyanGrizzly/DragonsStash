"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2, ExternalLink, Link2, Send } from "lucide-react";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface KickstarterRow {
  id: string;
  name: string;
  link: string | null;
  filesUrl: string | null;
  deliveryStatus: "NOT_DELIVERED" | "PARTIAL" | "DELIVERED";
  paymentStatus: "PAID" | "UNPAID";
  notes: string | null;
  hostId: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  host: { id: string; name: string } | null;
  _count: { packages: number };
}

interface KickstarterColumnsProps {
  onEdit: (kickstarter: KickstarterRow) => void;
  onDelete: (id: string) => void;
  onLinkPackages: (kickstarter: KickstarterRow) => void;
  onSendAll: (kickstarter: KickstarterRow) => void;
}

const deliveryConfig: Record<string, { label: string; className: string }> = {
  NOT_DELIVERED: {
    label: "Not Delivered",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
  },
  PARTIAL: {
    label: "Partial",
    className: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  },
  DELIVERED: {
    label: "Delivered",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
};

const paymentConfig: Record<string, { label: string; className: string }> = {
  PAID: {
    label: "Paid",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  UNPAID: {
    label: "Unpaid",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
  },
};

export function getKickstarterColumns({
  onEdit,
  onDelete,
  onLinkPackages,
  onSendAll,
}: KickstarterColumnsProps): ColumnDef<KickstarterRow, unknown>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          {row.original.link && (
            <a
              href={row.original.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "host",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Host" />,
      cell: ({ row }) =>
        row.original.host ? (
          <span className="text-sm">{row.original.host.name}</span>
        ) : (
          <span className="text-muted-foreground">--</span>
        ),
    },
    {
      id: "files",
      header: "Files",
      cell: ({ row }) =>
        row.original.filesUrl ? (
          <a
            href={row.original.filesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">--</span>
        ),
    },
    {
      accessorKey: "deliveryStatus",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Delivery" />,
      cell: ({ row }) => {
        const config = deliveryConfig[row.original.deliveryStatus];
        return (
          <Badge variant="outline" className={`text-[10px] font-medium ${config.className}`}>
            {config.label}
          </Badge>
        );
      },
    },
    {
      accessorKey: "paymentStatus",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Payment" />,
      cell: ({ row }) => {
        const config = paymentConfig[row.original.paymentStatus];
        return (
          <Badge variant="outline" className={`text-[10px] font-medium ${config.className}`}>
            {config.label}
          </Badge>
        );
      },
    },
    {
      id: "packages",
      header: "Packages",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original._count.packages}
        </span>
      ),
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
            <DropdownMenuItem onClick={() => onLinkPackages(row.original)}>
              <Link2 className="mr-2 h-3.5 w-3.5" />
              Link Packages
            </DropdownMenuItem>
            {row.original._count.packages > 0 && (
              <DropdownMenuItem onClick={() => onSendAll(row.original)}>
                <Send className="mr-2 h-3.5 w-3.5" />
                Send All ({row.original._count.packages})
              </DropdownMenuItem>
            )}
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
