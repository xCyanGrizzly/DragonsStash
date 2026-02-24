"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { submitAuthCode } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { AccountRow } from "@/lib/telegram/admin-queries";

interface AuthCodeDialogProps {
  account: AccountRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuthCodeDialog({
  account,
  open,
  onOpenChange,
}: AuthCodeDialogProps) {
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();

  const isPassword = account?.authState === "AWAITING_PASSWORD";
  const title = isPassword ? "Enter 2FA Password" : "Enter Auth Code";
  const description = isPassword
    ? "Your Telegram account requires a two-factor authentication password."
    : "Enter the code sent to your Telegram app or SMS.";
  const placeholder = isPassword ? "Password" : "12345";

  function handleSubmit() {
    if (!account || !code.trim()) return;

    startTransition(async () => {
      const result = await submitAuthCode(account.id, { code: code.trim() });
      if (result.success) {
        toast.success(isPassword ? "Password submitted" : "Code submitted");
        setCode("");
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setCode("");
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="auth-code">
            {isPassword ? "Password" : "Code"}
          </Label>
          <Input
            id="auth-code"
            type={isPassword ? "password" : "text"}
            placeholder={placeholder}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !code.trim()}
          >
            {isPending ? "Submitting..." : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
