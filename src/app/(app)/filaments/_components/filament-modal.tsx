"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FilamentForm } from "./filament-form";

interface FilamentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filament?: Parameters<typeof FilamentForm>[0]["filament"];
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export function FilamentModal({
  open,
  onOpenChange,
  filament,
  vendors,
  locations,
}: FilamentModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{filament ? "Edit Filament" : "Add Filament"}</DialogTitle>
          <DialogDescription>
            {filament ? "Update the filament details below." : "Add a new filament spool to your inventory."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-4">
          <FilamentForm
            filament={filament}
            vendors={vendors}
            locations={locations}
            onSuccess={() => onOpenChange(false)}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
