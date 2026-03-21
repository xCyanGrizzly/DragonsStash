"use client";

import { type ColumnDef } from "@tanstack/react-table";
import {
  MoreHorizontal,
  Trash2,
  Power,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCcw,
  Tag,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChannelRow } from "@/lib/telegram/admin-queries";

interface ChannelColumnsProps {
  onToggleActive: (id: string) => void;
  onDelete: (id: string) => void;
  onSetType: (id: string, type: "SOURCE" | "DESTINATION") => void;
  onRescan: (id: string) => void;
  onSetCategory: (id: string, category: string | null) => void;
}

export function getChannelColumns({
  onToggleActive,
  onDelete,
  onSetType,
  onRescan,
  onSetCategory,
}: ChannelColumnsProps): ColumnDef<ChannelRow, unknown>[] {
  return [
    {
      accessorKey: "title",
      header: "Channel",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.title}</span>
          <span className="text-xs text-muted-foreground">
            ID: {row.original.telegramId}
          </span>
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <Badge
          variant="outline"
          className={
            row.original.type === "SOURCE"
              ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
              : "bg-purple-500/10 text-purple-600 border-purple-500/20"
          }
        >
          {row.original.type}
        </Badge>
      ),
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ row }) => {
        const category = row.original.category;
        return category ? (
          <Badge variant="outline">{category}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      accessorKey: "isActive",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? "default" : "secondary"}>
          {row.original.isActive ? "Active" : "Disabled"}
        </Badge>
      ),
    },
    {
      id: "accounts",
      header: "Accounts",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.accountCount}
        </span>
      ),
    },
    {
      id: "packages",
      header: "Packages",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.packageCount}
        </span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
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
            {row.original.type === "SOURCE" ? (
              <DropdownMenuItem
                onClick={() => onSetType(row.original.id, "DESTINATION")}
              >
                <ArrowDownToLine className="mr-2 h-3.5 w-3.5" />
                Set as Destination
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() => onSetType(row.original.id, "SOURCE")}
              >
                <ArrowUpFromLine className="mr-2 h-3.5 w-3.5" />
                Set as Source
              </DropdownMenuItem>
            )}
            {row.original.type === "SOURCE" && (
              <DropdownMenuItem
                onClick={() => onRescan(row.original.id)}
              >
                <RefreshCcw className="mr-2 h-3.5 w-3.5" />
                Rescan Channel
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                const cat = prompt("Enter category (e.g. STL, PDF, D&D, Cosplay):", row.original.category ?? "");
                if (cat !== null) onSetCategory(row.original.id, cat || null);
              }}
            >
              <Tag className="mr-2 h-3.5 w-3.5" />
              Set Category
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onToggleActive(row.original.id)}
            >
              <Power className="mr-2 h-3.5 w-3.5" />
              {row.original.isActive ? "Disable" : "Enable"}
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
