"use client";

import { useState, useEffect, useTransition } from "react";
import { Database, AlertTriangle, Link2, Plus, Loader2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { createDestinationViaWorker, setGlobalDestination } from "../actions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GlobalDestination, ChannelRow } from "@/lib/telegram/admin-queries";

interface DestinationCardProps {
  destination: GlobalDestination;
  channels?: ChannelRow[];
}

type CreateState =
  | { phase: "idle" }
  | { phase: "creating"; requestId?: string }
  | { phase: "done"; title: string; telegramId: string }
  | { phase: "error"; message: string };

export function DestinationCard({ destination, channels = [] }: DestinationCardProps) {
  const [isPending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("dragonsstash db");
  const [createState, setCreateState] = useState<CreateState>({ phase: "idle" });
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");

  // Channels that can be assigned as destination (SOURCE channels only, exclude current destination)
  const assignableChannels = channels.filter(
    (c) => c.type === "SOURCE" && c.id !== destination?.id
  );

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

  const handleAssignExisting = () => {
    if (!selectedChannelId) return;

    startTransition(async () => {
      const result = await setGlobalDestination(selectedChannelId);
      if (result.success) {
        toast.success("Channel set as destination!");
        setCreateOpen(false);
        setSelectedChannelId("");
      } else {
        toast.error(result.error ?? "Failed to set destination");
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
      setSelectedChannelId("");
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
              Set Destination
            </Button>
          </CardContent>
        </Card>

        <DestinationDialog
          open={createOpen}
          onOpenChange={handleOpenChange}
          title={title}
          setTitle={setTitle}
          onSubmitCreate={handleCreate}
          createState={createState}
          isPending={isPending}
          assignableChannels={assignableChannels}
          selectedChannelId={selectedChannelId}
          setSelectedChannelId={setSelectedChannelId}
          onSubmitAssign={handleAssignExisting}
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

      <DestinationDialog
        open={createOpen}
        onOpenChange={handleOpenChange}
        title={title}
        setTitle={setTitle}
        onSubmitCreate={handleCreate}
        createState={createState}
        isPending={isPending}
        assignableChannels={assignableChannels}
        selectedChannelId={selectedChannelId}
        setSelectedChannelId={setSelectedChannelId}
        onSubmitAssign={handleAssignExisting}
      />
    </>
  );
}

function DestinationDialog({
  open,
  onOpenChange,
  title,
  setTitle,
  onSubmitCreate,
  createState,
  isPending,
  assignableChannels,
  selectedChannelId,
  setSelectedChannelId,
  onSubmitAssign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  setTitle: (v: string) => void;
  onSubmitCreate: () => void;
  createState: CreateState;
  isPending: boolean;
  assignableChannels: ChannelRow[];
  selectedChannelId: string;
  setSelectedChannelId: (v: string) => void;
  onSubmitAssign: () => void;
}) {
  const isCreating = createState.phase === "creating";
  const hasAssignable = assignableChannels.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set Destination Channel</DialogTitle>
          <DialogDescription>
            Choose an existing channel or create a new private group. All
            accounts will write archives to this destination.
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
          <Tabs defaultValue={hasAssignable ? "existing" : "create"} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="existing" disabled={!hasAssignable}>
                <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                Use Existing
              </TabsTrigger>
              <TabsTrigger value="create">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create New
              </TabsTrigger>
            </TabsList>

            <TabsContent value="existing" className="space-y-4 pt-2">
              {createState.phase === "error" && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">{createState.message}</p>
                </div>
              )}

              <div className="space-y-2">
                <Label>Select Channel</Label>
                <Select
                  value={selectedChannelId}
                  onValueChange={setSelectedChannelId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a channel..." />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableChannels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.title}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({ch.telegramId})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The selected channel will become the destination. All accounts
                  will be linked as writers automatically.
                </p>
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={onSubmitAssign}
                  disabled={isPending || !selectedChannelId}
                >
                  {isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Set as Destination
                </Button>
              </DialogFooter>
            </TabsContent>

            <TabsContent value="create" className="space-y-4 pt-2">
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
                  A new private Telegram group will be created using one of your
                  authenticated accounts. You can rename it later in Telegram.
                </p>
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={onSubmitCreate}
                  disabled={isPending || !title.trim()}
                >
                  {isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Create Group
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
