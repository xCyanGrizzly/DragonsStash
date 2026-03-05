"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { getChannelColumns } from "./channel-columns";
import { DestinationCard } from "./destination-card";
import {
  deleteChannel,
  toggleChannelActive,
  setChannelType,
  rescanChannel,
} from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import type { ChannelRow, GlobalDestination } from "@/lib/telegram/admin-queries";
import { useDataTable } from "@/hooks/use-data-table";

interface ChannelsTabProps {
  channels: ChannelRow[];
  globalDestination: GlobalDestination;
}

export function ChannelsTab({ channels, globalDestination }: ChannelsTabProps) {
  const [isPending, startTransition] = useTransition();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [rescanId, setRescanId] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      <DestinationCard destination={globalDestination} />

      {channels.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Source channels are added per-account via the &quot;Fetch Channels&quot; button on the Accounts tab.
        </p>
      )}

      <DataTable
        table={table}
        emptyMessage="No channels yet. Use &quot;Fetch Channels&quot; on an account to discover and add source channels."
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
    </div>
  );
}
