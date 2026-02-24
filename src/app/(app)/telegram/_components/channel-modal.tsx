"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChannelForm } from "./channel-form";
import type { ChannelRow } from "@/lib/telegram/admin-queries";

interface ChannelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel?: ChannelRow;
}

export function ChannelModal({
  open,
  onOpenChange,
  channel,
}: ChannelModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {channel ? "Edit Channel" : "Add Channel"}
          </DialogTitle>
          <DialogDescription>
            {channel
              ? "Update the channel details below."
              : "Add a Telegram channel. Source channels are scanned for archives, destination channels receive indexed files."}
          </DialogDescription>
        </DialogHeader>
        <ChannelForm
          channel={channel}
          onSuccess={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
