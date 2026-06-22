"use client";

import { useState, useEffect, useCallback, useMemo, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { setTopicFetchEnabled } from "../actions";

interface TopicRow {
  id: string;
  topicId: string;
  topicName: string | null;
  fetchEnabled: boolean;
  lastScannedAt: string | null;
}

interface TopicsDrawerProps {
  channelId: string | null;
  channelTitle?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function topicLabel(t: TopicRow): string {
  return t.topicName ?? `Topic ${t.topicId}`;
}

export function TopicsDrawer({
  channelId,
  channelTitle,
  open,
  onOpenChange,
}: TopicsDrawerProps) {
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const fetchTopics = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/telegram/channels/${channelId}/topics`);
      if (res.ok) setTopics(await res.json());
      else toast.error("Failed to load topics");
    } catch {
      toast.error("Failed to load topics");
    }
    setLoading(false);
  }, [channelId]);

  useEffect(() => {
    if (open && channelId) fetchTopics();
  }, [open, channelId, fetchTopics]);

  const handleOpenChange = (next: boolean) => {
    // Reset the filter on close so the next open starts clean (the drawer is
    // opened per-channel, so close-then-open is the normal channel switch).
    if (!next) setFilter("");
    onOpenChange(next);
  };

  const handleToggle = (topic: TopicRow, enabled: boolean) => {
    // Optimistic update
    setTopics((prev) =>
      prev.map((t) => (t.id === topic.id ? { ...t, fetchEnabled: enabled } : t))
    );
    setPendingId(topic.id);
    startTransition(async () => {
      const result = await setTopicFetchEnabled(topic.id, enabled);
      if (!result.success) {
        toast.error(result.error ?? "Failed to update topic");
        // Revert on failure
        setTopics((prev) =>
          prev.map((t) =>
            t.id === topic.id ? { ...t, fetchEnabled: !enabled } : t
          )
        );
      }
      setPendingId(null);
    });
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter((t) => topicLabel(t).toLowerCase().includes(q));
  }, [topics, filter]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border space-y-3">
          <div className="space-y-1">
            <DialogTitle className="truncate pr-8">
              Topics{channelTitle ? `: ${channelTitle}` : ""}
            </DialogTitle>
            <DialogDescription>
              Enabled topics are scanned and their files fetched. Disable a topic
              to stop fetching new files from it — already-fetched files are kept.
            </DialogDescription>
          </div>
          {topics.length > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter topics..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
          )}
        </DialogHeader>

        {/* Native overflow scroll: the Radix ScrollArea viewport does not get a
            bounded height inside this flex-column, max-h, vertically-centred
            dialog, so the list overflowed instead of scrolling. flex-1 +
            min-h-0 + overflow-y-auto is the canonical, touch-friendly fix. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-6 py-4 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Loading topics...
                </span>
              </div>
            ) : topics.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No topics discovered yet — they&apos;ll appear here after the next
                scan.
              </p>
            ) : filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No topics match &quot;{filter}&quot;.
              </p>
            ) : (
              filtered.map((topic) => (
                <div
                  key={topic.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {topicLabel(topic)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {topic.fetchEnabled
                        ? "Fetching enabled"
                        : "Fetching disabled"}
                      {topic.lastScannedAt
                        ? ` · last scanned ${new Date(
                            topic.lastScannedAt
                          ).toLocaleDateString()}`
                        : " · not scanned yet"}
                    </p>
                  </div>
                  <Switch
                    checked={topic.fetchEnabled}
                    disabled={pendingId === topic.id}
                    onCheckedChange={(checked) => handleToggle(topic, checked)}
                    aria-label={`Toggle fetching for ${topicLabel(topic)}`}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
