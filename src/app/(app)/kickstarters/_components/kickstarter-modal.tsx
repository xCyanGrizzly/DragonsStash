"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KickstarterForm } from "./kickstarter-form";

interface HostOption {
  id: string;
  name: string;
  _count: { kickstarters: number };
}

interface KickstarterModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: HostOption[];
  kickstarter?: {
    id: string;
    name: string;
    link: string | null;
    filesUrl: string | null;
    deliveryStatus: "NOT_DELIVERED" | "PARTIAL" | "DELIVERED";
    paymentStatus: "PAID" | "UNPAID";
    hostId: string | null;
    notes: string | null;
  };
}

export function KickstarterModal({ open, onOpenChange, hosts, kickstarter }: KickstarterModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{kickstarter ? "Edit Kickstarter" : "Add Kickstarter"}</DialogTitle>
          <DialogDescription>
            {kickstarter
              ? "Update the kickstarter details below."
              : "Track a new Kickstarter or crowdfunding campaign."}
          </DialogDescription>
        </DialogHeader>
        <KickstarterForm
          kickstarter={kickstarter}
          hosts={hosts}
          onSuccess={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
