"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LocationForm } from "./location-form";

interface LocationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location?: { id: string; name: string; description: string | null };
}

export function LocationModal({ open, onOpenChange, location }: LocationModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{location ? "Edit Location" : "Add Location"}</DialogTitle>
          <DialogDescription>
            {location
              ? "Update the location details below."
              : "Add a new storage location."}
          </DialogDescription>
        </DialogHeader>
        <LocationForm location={location} onSuccess={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
