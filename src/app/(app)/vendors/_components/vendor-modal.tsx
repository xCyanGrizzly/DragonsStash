"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VendorForm } from "./vendor-form";

interface VendorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor?: { id: string; name: string; website: string | null; notes: string | null };
}

export function VendorModal({ open, onOpenChange, vendor }: VendorModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{vendor ? "Edit Vendor" : "Add Vendor"}</DialogTitle>
          <DialogDescription>
            {vendor ? "Update the vendor details below." : "Add a new vendor to your inventory."}
          </DialogDescription>
        </DialogHeader>
        <VendorForm vendor={vendor} onSuccess={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
