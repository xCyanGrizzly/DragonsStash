"use client";

import { useState, useTransition } from "react";
import { Send, Link2, Unlink, Copy, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  generateTelegramLinkCode,
  unlinkTelegram,
} from "../telegram-actions";

interface TelegramLinkCardProps {
  linked: boolean;
  telegramName: string | null;
  telegramUserId: string | null;
  linkedAt: string | null;
  botUsername?: string | null;
}

export function TelegramLinkCard({
  linked: initialLinked,
  telegramName: initialName,
  telegramUserId: initialUserId,
  linkedAt: initialLinkedAt,
  botUsername,
}: TelegramLinkCardProps) {
  const [isPending, startTransition] = useTransition();
  const [linked, setLinked] = useState(initialLinked);
  const [telegramName, setTelegramName] = useState(initialName);
  const [telegramUserId, setTelegramUserId] = useState(initialUserId);
  const [linkedAt, setLinkedAt] = useState(initialLinkedAt);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleGenerateCode() {
    startTransition(async () => {
      const result = await generateTelegramLinkCode();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setLinkCode(result.data.code);
      setCodeExpiresAt(result.data.expiresAt);
      toast.success("Link code generated! Send it to the bot within 10 minutes.");
    });
  }

  function handleUnlink() {
    startTransition(async () => {
      const result = await unlinkTelegram();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setLinked(false);
      setTelegramName(null);
      setTelegramUserId(null);
      setLinkedAt(null);
      setLinkCode(null);
      toast.success("Telegram account unlinked");
    });
  }

  async function handleCopy() {
    if (!linkCode) return;
    const command = `/link ${linkCode}`;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  const botLink = botUsername
    ? `https://t.me/${botUsername}?start=link_${linkCode}`
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Send className="h-5 w-5 text-primary" />
          <CardTitle>Telegram Link</CardTitle>
          {linked ? (
            <Badge variant="default" className="ml-auto">
              Linked
            </Badge>
          ) : (
            <Badge variant="secondary" className="ml-auto">
              Not linked
            </Badge>
          )}
        </div>
        <CardDescription>
          Link your account to receive packages via the Telegram bot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {linked ? (
          <>
            <div className="rounded-lg border p-4 space-y-2 bg-muted/30">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Telegram:</span>
                <span className="font-medium">
                  {telegramName ?? `User ${telegramUserId}`}
                </span>
              </div>
              {linkedAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Linked:</span>
                  <span>{new Date(linkedAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleUnlink}
              disabled={isPending}
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Unlink className="h-4 w-4 mr-1" />
              )}
              Unlink Account
            </Button>
          </>
        ) : (
          <>
            {linkCode ? (
              <div className="space-y-3">
                <div className="rounded-lg border p-4 space-y-2 bg-muted/30">
                  <p className="text-sm text-muted-foreground">
                    Send this command to the bot:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded bg-background px-3 py-2 text-sm font-mono border">
                      /link {linkCode}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={handleCopy}
                    >
                      {copied ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {codeExpiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Expires:{" "}
                      {new Date(codeExpiresAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                {botLink && (
                  <a
                    href={botLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Or click here to open the bot directly
                  </a>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateCode}
                  disabled={isPending}
                >
                  {isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Generate New Code
                </Button>
              </div>
            ) : (
              <Button
                variant="default"
                onClick={handleGenerateCode}
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Link2 className="h-4 w-4 mr-1" />
                )}
                Generate Link Code
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
