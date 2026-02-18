"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PaintForm } from "./paint-form";

interface PaintModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paint?: Parameters<typeof PaintForm>[0]["paint"];
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export function PaintModal({
  open,
  onOpenChange,
  paint,
  vendors,
  locations,
}: PaintModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{paint ? "Edit Paint" : "Add Paint"}</DialogTitle>
          <DialogDescription>
            {paint
              ? "Update the paint details below."
              : "Add a new paint to your inventory."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-4">
          <PaintForm
            paint={paint}
            vendors={vendors}
            locations={locations}
            onSuccess={() => onOpenChange(false)}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
