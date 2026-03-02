"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { getChannelColumns } from "./channel-columns";
import { DestinationCard } from "./destination-card";
import {
  deleteChannel,
  toggleChannelActive,
  setChannelType,
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
    </div>
  );
}
