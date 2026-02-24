"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import { Link2Off, Plus } from "lucide-react";
import { toast } from "sonner";
import { linkChannel, unlinkChannel } from "../actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface ChannelLink {
  id: string;
  channelId: string;
  role: string;
  lastProcessedMessageId: string | null;
  channel: {
    id: string;
    title: string;
    type: string;
    telegramId: string;
  };
}

interface UnlinkedChannel {
  id: string;
  title: string;
  type: string;
  telegramId: string;
}

interface AccountLinksDrawerProps {
  accountId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountLinksDrawer({
  accountId,
  open,
  onOpenChange,
}: AccountLinksDrawerProps) {
  const [isPending, startTransition] = useTransition();
  const [links, setLinks] = useState<ChannelLink[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [selectedRole, setSelectedRole] = useState<"READER" | "WRITER">("READER");
  const [loading, setLoading] = useState(false);

  const fetchLinks = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [linksRes, unlinkedRes] = await Promise.all([
        fetch(`/api/telegram/accounts/${accountId}/links`),
        fetch(`/api/telegram/accounts/${accountId}/unlinked-channels`),
      ]);
      if (linksRes.ok) setLinks(await linksRes.json());
      if (unlinkedRes.ok) setUnlinked(await unlinkedRes.json());
    } catch {
      toast.error("Failed to load channel links");
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    if (open && accountId) {
      fetchLinks();
    }
  }, [open, accountId, fetchLinks]);

  const handleLink = () => {
    if (!accountId || !selectedChannelId) return;
    startTransition(async () => {
      const result = await linkChannel({
        accountId,
        channelId: selectedChannelId,
        role: selectedRole,
      });
      if (result.success) {
        toast.success("Channel linked");
        setSelectedChannelId("");
        await fetchLinks();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleUnlink = (linkId: string) => {
    startTransition(async () => {
      const result = await unlinkChannel(linkId);
      if (result.success) {
        toast.success("Channel unlinked");
        await fetchLinks();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Channel Links</DialogTitle>
          <DialogDescription>
            Link channels to this account. The account will read from Source
            channels and write to Destination channels.
          </DialogDescription>
        </DialogHeader>

        {/* Add new link */}
        {unlinked.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Link a Channel</h4>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  value={selectedChannelId}
                  onValueChange={setSelectedChannelId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {unlinked.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        {ch.title} ({ch.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Select
                value={selectedRole}
                onValueChange={(v) => setSelectedRole(v as "READER" | "WRITER")}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="READER">Reader</SelectItem>
                  <SelectItem value="WRITER">Writer</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!selectedChannelId || isPending}
                onClick={handleLink}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Link
              </Button>
            </div>
            <Separator />
          </div>
        )}

        {/* Existing links */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            Linked Channels ({links.length})
          </h4>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : links.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels linked to this account.
            </p>
          ) : (
            <div className="space-y-2">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {link.channel.title}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          link.channel.type === "SOURCE"
                            ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
                            : "bg-purple-500/10 text-purple-600 border-purple-500/20"
                        }
                      >
                        {link.channel.type}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {link.role}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      ID: {link.channel.telegramId}
                      {link.lastProcessedMessageId &&
                        ` | Last msg: ${link.lastProcessedMessageId}`}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    disabled={isPending}
                    onClick={() => handleUnlink(link.id)}
                  >
                    <Link2Off className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
