"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface SendToTelegramButtonProps {
  packageId: string;
  packageName: string;
  /** variant for inline row actions vs larger button */
  variant?: "icon" | "default";
}

type SendStatus = "idle" | "sending" | "polling" | "sent" | "failed";

export function SendToTelegramButton({
  packageId,
  packageName,
  variant = "default",
}: SendToTelegramButtonProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SendStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function handleSend() {
    startTransition(async () => {
      setStatus("sending");
      setError(null);

      try {
        const res = await fetch("/api/telegram/bot/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packageId }),
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus("failed");
          setError(data.error ?? "Failed to queue send");
          return;
        }

        // Start polling for status
        setStatus("polling");
        const requestId = data.requestId;

        pollRef.current = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/telegram/bot/send/${requestId}`);
            const statusData = await statusRes.json();

            if (statusData.status === "SENT") {
              setStatus("sent");
              toast.success(`"${packageName}" sent to Telegram`);
              if (pollRef.current) clearInterval(pollRef.current);
            } else if (statusData.status === "FAILED") {
              setStatus("failed");
              setError(statusData.error ?? "Send failed");
              if (pollRef.current) clearInterval(pollRef.current);
            }
            // PENDING / SENDING — keep polling
          } catch {
            // Network error — keep trying
          }
        }, 2000);

        // Stop polling after 60 seconds
        setTimeout(() => {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setStatus((s: SendStatus) => {
            if (s === "polling") return "sent"; // Assume queued successfully
            return s;
          });
        }, 60000);
      } catch {
        setStatus("failed");
        setError("Network error");
      }
    });
  }

  function handleClose() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setOpen(false);
    // Reset after animation
    setTimeout(() => {
      setStatus("idle");
      setError(null);
    }, 200);
  }

  const trigger =
    variant === "icon" ? (
      <Button variant="ghost" size="icon" className="h-8 w-8" title="Send to Telegram">
        <Send className="h-4 w-4" />
      </Button>
    ) : (
      <Button variant="outline" size="sm" className="gap-1.5">
        <Send className="h-3.5 w-3.5" />
        Send to Telegram
      </Button>
    );

  return (
    <Dialog open={open} onOpenChange={(o: boolean) => (o ? setOpen(true) : handleClose())}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send to Telegram</DialogTitle>
          <DialogDescription>
            Send &ldquo;{packageName}&rdquo; to your linked Telegram account.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {status === "idle" && (
            <p className="text-sm text-muted-foreground">
              The bot will forward the archive files from the destination channel
              to your linked Telegram account.
            </p>
          )}

          {(status === "sending" || status === "polling") && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/30 border">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">
                  {status === "sending" ? "Queuing…" : "Sending…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  The bot is forwarding the files to your Telegram.
                </p>
              </div>
            </div>
          )}

          {status === "sent" && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm font-medium text-green-500">Sent!</p>
                <p className="text-xs text-muted-foreground">
                  Check your Telegram messages.
                </p>
              </div>
            </div>
          )}

          {status === "failed" && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/20">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">Failed</p>
                <p className="text-xs text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {status === "idle" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleSend} disabled={isPending}>
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Send
              </Button>
            </>
          )}

          {(status === "sent" || status === "failed") && (
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
