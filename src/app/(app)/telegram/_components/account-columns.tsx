"use client";

import { type ColumnDef } from "@tanstack/react-table";
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  Power,
  Link2,
  Play,
  KeyRound,
  Download,
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
import type { AccountRow } from "@/lib/telegram/admin-queries";

const authStateColors: Record<string, string> = {
  PENDING: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  AWAITING_CODE: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  AWAITING_PASSWORD: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  AUTHENTICATED: "bg-green-500/10 text-green-600 border-green-500/20",
  EXPIRED: "bg-red-500/10 text-red-600 border-red-500/20",
};

interface AccountColumnsProps {
  onEdit: (account: AccountRow) => void;
  onToggleActive: (id: string) => void;
  onDelete: (id: string) => void;
  onViewLinks: (id: string) => void;
  onTriggerSync: (id: string) => void;
  onEnterCode: (account: AccountRow) => void;
  onFetchChannels: (id: string) => void;
}

export function getAccountColumns({
  onEdit,
  onToggleActive,
  onDelete,
  onViewLinks,
  onTriggerSync,
  onEnterCode,
  onFetchChannels,
}: AccountColumnsProps): ColumnDef<AccountRow, unknown>[] {
  return [
    {
      accessorKey: "displayName",
      header: "Account",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">
            {row.original.displayName || row.original.phone}
          </span>
          {row.original.displayName && (
            <span className="text-xs text-muted-foreground">
              {row.original.phone}
            </span>
          )}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "authState",
      header: "Auth State",
      cell: ({ row }) => {
        const needsCode =
          row.original.authState === "AWAITING_CODE" ||
          row.original.authState === "AWAITING_PASSWORD";
        return (
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={authStateColors[row.original.authState] ?? ""}
            >
              {row.original.authState.replace(/_/g, " ")}
            </Badge>
            {needsCode && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => onEnterCode(row.original)}
              >
                <KeyRound className="h-3 w-3" />
                Enter Code
              </Button>
            )}
          </div>
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
      id: "channels",
      header: "Channels",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onViewLinks(row.original.id)}
        >
          <Link2 className="h-3 w-3" />
          {row.original.channelCount}
        </Button>
      ),
    },
    {
      id: "runs",
      header: "Runs",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.runCount}
        </span>
      ),
    },
    {
      accessorKey: "lastSeenAt",
      header: "Last Seen",
      cell: ({ row }) =>
        row.original.lastSeenAt ? (
          <span className="text-sm text-muted-foreground">
            {new Date(row.original.lastSeenAt).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Never</span>
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
            <DropdownMenuItem onClick={() => onViewLinks(row.original.id)}>
              <Link2 className="mr-2 h-3.5 w-3.5" />
              Manage Channels
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onFetchChannels(row.original.id)}
              disabled={row.original.authState !== "AUTHENTICATED"}
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Fetch Channels
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTriggerSync(row.original.id)}>
              <Play className="mr-2 h-3.5 w-3.5" />
              Sync Now
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
