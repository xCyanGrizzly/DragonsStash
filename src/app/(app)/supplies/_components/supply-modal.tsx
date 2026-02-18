"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SupplyForm } from "./supply-form";

interface SupplyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supply?: Parameters<typeof SupplyForm>[0]["supply"];
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export function SupplyModal({
  open,
  onOpenChange,
  supply,
  vendors,
  locations,
}: SupplyModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{supply ? "Edit Supply" : "Add Supply"}</DialogTitle>
          <DialogDescription>
            {supply
              ? "Update the supply details below."
              : "Add a new supply to your inventory."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-4">
          <SupplyForm
            supply={supply}
            vendors={vendors}
            locations={locations}
            onSuccess={() => onOpenChange(false)}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
