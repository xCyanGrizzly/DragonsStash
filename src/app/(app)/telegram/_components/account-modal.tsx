"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountForm } from "./account-form";
import type { AccountRow } from "@/lib/telegram/admin-queries";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: AccountRow;
}

export function AccountModal({
  open,
  onOpenChange,
  account,
}: AccountModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {account ? "Edit Account" : "Add Telegram Account"}
          </DialogTitle>
          <DialogDescription>
            {account
              ? "Update the account details below."
              : "Configure a new Telegram account for ingestion. You'll need an API ID and hash from my.telegram.org."}
          </DialogDescription>
        </DialogHeader>
        <AccountForm
          account={account}
          onSuccess={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
