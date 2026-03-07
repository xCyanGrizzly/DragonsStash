"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { getChannelColumns } from "./channel-columns";
import { DestinationCard } from "./destination-card";
import { ChannelPickerDialog } from "./channel-picker-dialog";
import {
  deleteChannel,
  toggleChannelActive,
  setChannelType,
  rescanChannel,
} from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { Button } from "@/components/ui/button";
import type { AccountRow, ChannelRow, GlobalDestination } from "@/lib/telegram/admin-queries";
import { useDataTable } from "@/hooks/use-data-table";

interface ChannelsTabProps {
  channels: ChannelRow[];
  globalDestination: GlobalDestination;
  accounts: AccountRow[];
}

export function ChannelsTab({ channels, globalDestination, accounts }: ChannelsTabProps) {
  const [isPending, startTransition] = useTransition();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [rescanId, setRescanId] = useState<string | null>(null);
  const [fetchChannelsAccountId, setFetchChannelsAccountId] = useState<string | null>(null);

  // Find the first authenticated account for "Fetch Channels"
  const authenticatedAccounts = accounts.filter((a) => a.authState === "AUTHENTICATED" && a.isActive);

  const columns = getChannelColumns({
    onToggleActive: (id) => {
      startTransition(async () => {
        const result = await toggleChannelActive(id);
        if (result.success) toast.success("Channel toggled");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onSetType: (id, type) => {
      startTransition(async () => {
        const result = await setChannelType(id, type);
        if (result.success) toast.success(`Channel set as ${type.toLowerCase()}`);
        else toast.error(result.error);
      });
    },
    onRescan: (id) => setRescanId(id),
  });

  const { table } = useDataTable({
    data: channels,
    columns,
    pageCount: 1,
  });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteChannel(deleteId);
      if (result.success) {
        toast.success("Channel deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleRescan = () => {
    if (!rescanId) return;
    startTransition(async () => {
      const result = await rescanChannel(rescanId);
      if (result.success) {
        toast.success("Channel scan progress reset — it will be fully rescanned on the next sync");
        setRescanId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleFetchChannels = () => {
    if (authenticatedAccounts.length > 0) {
      setFetchChannelsAccountId(authenticatedAccounts[0].id);
    } else {
      toast.error("No authenticated accounts available. Add and authenticate an account first.");
    }
  };

  return (
    <div className="space-y-4">
      <DestinationCard destination={globalDestination} channels={channels} />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={handleFetchChannels}
          disabled={authenticatedAccounts.length === 0}
        >
          <Download className="mr-2 h-4 w-4" />
          Fetch Channels
        </Button>
      </div>

      {channels.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Channels discovered via &quot;Fetch Channels&quot; are automatically activated as sources.
        </p>
      )}

      <DataTable
        table={table}
        emptyMessage="No channels yet. Click &quot;Fetch Channels&quot; above to discover and add source channels."
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Channel"
        description="This will permanently delete this channel and unlink it from all accounts. Existing packages will NOT be deleted."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      <DeleteDialog
        open={!!rescanId}
        onOpenChange={(open) => !open && setRescanId(null)}
        title="Rescan Channel"
        description="This will reset all scan progress for this channel. On the next sync the worker will re-process every message from the beginning. Packages that are already in the library will be skipped (deduplication by hash), but any missing files will be re-downloaded and re-uploaded. This may take a long time for large channels."
        confirmLabel="Rescan"
        onConfirm={handleRescan}
        isLoading={isPending}
      />

      <ChannelPickerDialog
        accountId={fetchChannelsAccountId}
        open={!!fetchChannelsAccountId}
        onOpenChange={(open) => {
          if (!open) setFetchChannelsAccountId(null);
        }}
      />
    </div>
  );
}
