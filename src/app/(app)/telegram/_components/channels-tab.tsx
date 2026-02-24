"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { getChannelColumns } from "./channel-columns";
import { ChannelModal } from "./channel-modal";
import { deleteChannel, toggleChannelActive } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { Button } from "@/components/ui/button";
import type { ChannelRow } from "@/lib/telegram/admin-queries";
import { useDataTable } from "@/hooks/use-data-table";

interface ChannelsTabProps {
  channels: ChannelRow[];
}

export function ChannelsTab({ channels }: ChannelsTabProps) {
  const [isPending, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [editChannel, setEditChannel] = useState<ChannelRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const columns = getChannelColumns({
    onEdit: (channel) => {
      setEditChannel(channel);
      setModalOpen(true);
    },
    onToggleActive: (id) => {
      startTransition(async () => {
        const result = await toggleChannelActive(id);
        if (result.success) toast.success("Channel toggled");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
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
      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            setEditChannel(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Channel
        </Button>
      </div>

      <DataTable
        table={table}
        emptyMessage="No channels configured. Add a Telegram channel to start ingesting."
      />

      <ChannelModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditChannel(undefined);
        }}
        channel={editChannel}
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
