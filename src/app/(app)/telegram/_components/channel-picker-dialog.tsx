"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import { Loader2, Search, CheckSquare, Square, Radio } from "lucide-react";
import { toast } from "sonner";
import { saveChannelSelections } from "../actions";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";

interface FetchedChannel {
  chatId: string;
  title: string;
  type: "channel" | "supergroup";
  isForum: boolean;
  memberCount: number | null;
  alreadyLinked: boolean;
  existingChannelId: string | null;
}

interface ChannelPickerDialogProps {
  accountId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FetchState =
  | { phase: "idle" }
  | { phase: "fetching"; requestId?: string }
  | { phase: "loaded"; channels: FetchedChannel[] }
  | { phase: "error"; message: string };

export function ChannelPickerDialog({
  accountId,
  open,
  onOpenChange,
}: ChannelPickerDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [fetchState, setFetchState] = useState<FetchState>({ phase: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // Start fetching when dialog opens
  useEffect(() => {
    if (!open || !accountId) {
      setFetchState({ phase: "idle" });
      setSelected(new Set());
      setSearch("");
      return;
    }

    let mounted = true;

    const startFetch = async () => {
      setFetchState({ phase: "fetching" });

      try {
        // POST to create a fetch request
        const postRes = await fetch(
          `/api/telegram/accounts/${accountId}/fetch-channels`,
          { method: "POST" }
        );

        if (!postRes.ok) {
          let message = `Server error (${postRes.status})`;
          try {
            const err = await postRes.json();
            message = err.error || message;
          } catch {
            // response wasn't JSON
          }
          if (mounted) setFetchState({ phase: "error", message });
          return;
        }

        const { requestId } = await postRes.json();
        if (mounted) setFetchState({ phase: "fetching", requestId });

        // Poll for result
        const poll = async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (!mounted) return;

            const getRes = await fetch(
              `/api/telegram/accounts/${accountId}/fetch-channels?requestId=${requestId}`
            );
            if (!getRes.ok) continue;

            const data = await getRes.json();
            if (data.status === "COMPLETED") {
              if (mounted) {
                // Filter out already-linked channels
                const available = (data.channels as FetchedChannel[]).filter(
                  (ch) => !ch.alreadyLinked
                );
                setFetchState({ phase: "loaded", channels: available });
              }
              return;
            } else if (data.status === "FAILED") {
              if (mounted) {
                setFetchState({
                  phase: "error",
                  message: data.error || "Fetch failed",
                });
              }
              return;
            }
          }

          if (mounted) {
            setFetchState({ phase: "error", message: "Fetch timed out" });
          }
        };

        await poll();
      } catch (err) {
        if (mounted) {
          const message = err instanceof Error ? err.message : "Network error";
          setFetchState({ phase: "error", message: `Network error: ${message}` });
        }
      }
    };

    startFetch();
    return () => { mounted = false; };
  }, [open, accountId]);

  const channels =
    fetchState.phase === "loaded" ? fetchState.channels : [];

  const filteredChannels = channels.filter((ch) =>
    ch.title.toLowerCase().includes(search.toLowerCase())
  );

  const toggleChannel = (chatId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) {
        next.delete(chatId);
      } else {
        next.add(chatId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(filteredChannels.map((ch) => ch.chatId)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const handleSave = () => {
    if (!accountId || selected.size === 0) return;

    const selectedChannels = channels
      .filter((ch) => selected.has(ch.chatId))
      .map((ch) => ({
        telegramId: ch.chatId,
        title: ch.title,
        isForum: ch.isForum,
      }));

    startTransition(async () => {
      const result = await saveChannelSelections(accountId, selectedChannels);
      if (result.success) {
        toast.success(`${selectedChannels.length} channel(s) linked as source`);
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Select Source Channels</DialogTitle>
          <DialogDescription>
            Choose which channels to scan for archives. Already-linked channels
            are hidden.
          </DialogDescription>
        </DialogHeader>

        {fetchState.phase === "fetching" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              Fetching channels from Telegram...
            </p>
            <p className="text-xs text-muted-foreground">
              This may take a few seconds
            </p>
          </div>
        )}

        {fetchState.phase === "error" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="text-sm text-destructive">{fetchState.message}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Reopen to re-trigger fetch
                onOpenChange(false);
                setTimeout(() => onOpenChange(true), 100);
              }}
            >
              Retry
            </Button>
          </div>
        )}

        {fetchState.phase === "loaded" && (
          <>
            {channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <p className="text-sm text-muted-foreground">
                  All channels are already linked to this account.
                </p>
              </div>
            ) : (
              <>
                {/* Search + bulk actions */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Filter channels..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={selectAll}>
                    All
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    None
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  {filteredChannels.length} channel(s) available
                  {selected.size > 0 && ` \u2014 ${selected.size} selected`}
                </p>

                {/* Channel list */}
                <ScrollArea className="flex-1 max-h-[400px] -mx-2 px-2">
                  <div className="space-y-1">
                    {filteredChannels.map((ch) => (
                      <label
                        key={ch.chatId}
                        className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                      >
                        <Checkbox
                          checked={selected.has(ch.chatId)}
                          onCheckedChange={() => toggleChannel(ch.chatId)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">
                              {ch.title}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] shrink-0"
                            >
                              {ch.type}
                            </Badge>
                            {ch.isForum && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] shrink-0"
                              >
                                forum
                              </Badge>
                            )}
                            {!ch.existingChannelId && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20 shrink-0"
                              >
                                new
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            ID: {ch.chatId}
                            {ch.memberCount ? ` \u2022 ${ch.memberCount} members` : ""}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isPending ||
              selected.size === 0 ||
              fetchState.phase !== "loaded"
            }
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Link {selected.size} Channel{selected.size !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
