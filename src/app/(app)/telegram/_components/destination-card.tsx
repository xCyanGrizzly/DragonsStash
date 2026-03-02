"use client";

import { useState, useEffect, useTransition } from "react";
import { Database, AlertTriangle, Link2, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createDestinationViaWorker } from "../actions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { GlobalDestination } from "@/lib/telegram/admin-queries";

interface DestinationCardProps {
  destination: GlobalDestination;
}

type CreateState =
  | { phase: "idle" }
  | { phase: "creating"; requestId?: string }
  | { phase: "done"; title: string; telegramId: string }
  | { phase: "error"; message: string };

export function DestinationCard({ destination }: DestinationCardProps) {
  const [isPending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("dragonsstash db");
  const [createState, setCreateState] = useState<CreateState>({ phase: "idle" });

  // Poll for worker result when creating
  useEffect(() => {
    if (createState.phase !== "creating" || !createState.requestId) return;

    let mounted = true;
    const requestId = createState.requestId;

    const poll = async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!mounted) return;

        try {
          const res = await fetch(
            `/api/telegram/worker-request?requestId=${requestId}`
          );
          if (!res.ok) continue;

          const data = await res.json();
          if (data.status === "COMPLETED" && data.result) {
            if (mounted) {
              setCreateState({
                phase: "done",
                title: data.result.title,
                telegramId: data.result.telegramId,
              });
              toast.success(`Telegram group "${data.result.title}" created and set as destination!`);
              setCreateOpen(false);
              // Refresh the page to show the new destination
              window.location.reload();
            }
            return;
          } else if (data.status === "FAILED") {
            if (mounted) {
              setCreateState({
                phase: "error",
                message: data.error || "Worker failed to create the group",
              });
            }
            return;
          }
        } catch {
          // Network blip — keep polling
        }
      }

      if (mounted) {
        setCreateState({ phase: "error", message: "Timed out waiting for the worker" });
      }
    };

    poll();
    return () => { mounted = false; };
  }, [createState]);

  const handleCreate = () => {
    if (!title.trim()) return;

    startTransition(async () => {
      const result = await createDestinationViaWorker(title.trim());
      if (result.success) {
        setCreateState({ phase: "creating", requestId: result.data.requestId });
      } else {
        setCreateState({ phase: "error", message: result.error ?? "Unknown error" });
      }
    });
  };

  const handleOpenChange = (open: boolean) => {
    setCreateOpen(open);
    if (!open) {
      // Reset state when closing (unless actively creating)
      if (createState.phase !== "creating") {
        setCreateState({ phase: "idle" });
      }
    }
  };

  if (!destination) {
    return (
      <>
        <Card className="border-dashed border-yellow-500/40">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  No destination channel configured
                </p>
                <p className="text-xs text-muted-foreground">
                  Create a private Telegram group that all accounts will write
                  archives to. Requires at least one authenticated account.
                </p>
              </div>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-3.5 w-3.5" />
              Create Destination
            </Button>
          </CardContent>
        </Card>

        <CreateDestinationDialog
          open={createOpen}
          onOpenChange={handleOpenChange}
          title={title}
          setTitle={setTitle}
          onSubmit={handleCreate}
          createState={createState}
          isPending={isPending}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-purple-500 shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{destination.title}</p>
                <Badge
                  variant="outline"
                  className="bg-purple-500/10 text-purple-600 border-purple-500/20 text-[10px]"
                >
                  DESTINATION
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>ID: {destination.telegramId}</span>
                {destination.inviteLink && (
                  <span className="flex items-center gap-1">
                    <Link2 className="h-3 w-3" />
                    Invite link active
                  </span>
                )}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            Change
          </Button>
        </CardContent>
      </Card>

      <CreateDestinationDialog
        open={createOpen}
        onOpenChange={handleOpenChange}
        title={title}
        setTitle={setTitle}
        onSubmit={handleCreate}
        createState={createState}
        isPending={isPending}
      />
    </>
  );
}

function CreateDestinationDialog({
  open,
  onOpenChange,
  title,
  setTitle,
  onSubmit,
  createState,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  setTitle: (v: string) => void;
  onSubmit: () => void;
  createState: CreateState;
  isPending: boolean;
}) {
  const isCreating = createState.phase === "creating";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Destination Channel</DialogTitle>
          <DialogDescription>
            A private Telegram group will be created automatically using one of
            your authenticated accounts. All accounts will write archives here.
          </DialogDescription>
        </DialogHeader>

        {isCreating ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              Creating Telegram group...
            </p>
            <p className="text-xs text-muted-foreground">
              This may take a few seconds
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {createState.phase === "error" && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                <p className="text-sm text-destructive">{createState.message}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="dest-title">Group Name</Label>
              <Input
                id="dest-title"
                placeholder="e.g. dragonsstash db"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This will be the name of the Telegram group. You can rename it later in Telegram.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={isPending || isCreating || !title.trim()}
          >
            {(isPending || isCreating) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create Group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
