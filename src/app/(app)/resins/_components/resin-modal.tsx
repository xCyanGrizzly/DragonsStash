"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResinForm } from "./resin-form";

interface ResinModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resin?: Parameters<typeof ResinForm>[0]["resin"];
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export function ResinModal({
  open,
  onOpenChange,
  resin,
  vendors,
  locations,
}: ResinModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{resin ? "Edit Resin" : "Add Resin"}</DialogTitle>
          <DialogDescription>
            {resin
              ? "Update the resin details below."
              : "Add a new resin bottle to your inventory."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-4">
          <ResinForm
            resin={resin}
            vendors={vendors}
            locations={locations}
            onSuccess={() => onOpenChange(false)}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
