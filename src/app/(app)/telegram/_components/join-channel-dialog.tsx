"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { joinChannelByLink } from "../actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface JoinChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type JoinState =
  | { phase: "idle" }
  | { phase: "submitting"; requestId?: string }
  | { phase: "success"; title: string }
  | { phase: "error"; message: string };

export function JoinChannelDialog({
  open,
  onOpenChange,
}: JoinChannelDialogProps) {
  const [input, setInput] = useState("");
  const [joinState, setJoinState] = useState<JoinState>({ phase: "idle" });

  // Reset on close
  useEffect(() => {
    if (!open) {
      setInput("");
      setJoinState({ phase: "idle" });
    }
  }, [open]);

  const pollForResult = useCallback(async (requestId: string) => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const res = await fetch(
          `/api/telegram/worker-request?requestId=${requestId}`
        );
        if (!res.ok) continue;

        const data = await res.json();
        if (data.status === "COMPLETED") {
          const result = data.result;
          setJoinState({
            phase: "success",
            title: result?.title ?? "Unknown channel",
          });
          toast.success(`Channel "${result?.title}" added as source`);
          // Auto-close after short delay
          setTimeout(() => onOpenChange(false), 1500);
          return;
        } else if (data.status === "FAILED") {
          setJoinState({
            phase: "error",
            message: data.error || "Failed to join channel",
          });
          return;
        }
      } catch {
        // Network error, keep polling
      }
    }

    setJoinState({
      phase: "error",
      message: "Request timed out. The worker may be busy -- try again later.",
    });
  }, [onOpenChange]);

  const handleSubmit = async () => {
    if (!input.trim()) return;

    setJoinState({ phase: "submitting" });

    try {
      const result = await joinChannelByLink(input);
      if (!result.success) {
        setJoinState({ phase: "error", message: result.error ?? "Unknown error" });
        return;
      }

      const requestId = result.data!.requestId;
      setJoinState({ phase: "submitting", requestId });
      await pollForResult(requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setJoinState({ phase: "error", message });
    }
  };

  const isSubmitting = joinState.phase === "submitting";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Channel</DialogTitle>
          <DialogDescription>
            Join a Telegram channel or group by link, username, or invite link.
            The channel will be added as an active source.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="channel-input">Channel link or username</Label>
            <Input
              id="channel-input"
              placeholder="@channel, t.me/channel, or t.me/+invite"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isSubmitting && input.trim()) {
                  handleSubmit();
                }
              }}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              Supported formats: @username, https://t.me/username, https://t.me/+invitecode
            </p>
          </div>

          {joinState.phase === "submitting" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {joinState.requestId
                ? "Joining channel via worker..."
                : "Sending request..."}
            </div>
          )}

          {joinState.phase === "error" && (
            <p className="text-sm text-destructive">{joinState.message}</p>
          )}

          {joinState.phase === "success" && (
            <p className="text-sm text-emerald-600">
              Successfully added &quot;{joinState.title}&quot;
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {joinState.phase === "success" ? "Close" : "Cancel"}
          </Button>
          {joinState.phase !== "success" && (
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || !input.trim()}
            >
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LinkIcon className="mr-2 h-4 w-4" />
              )}
              Add Channel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
