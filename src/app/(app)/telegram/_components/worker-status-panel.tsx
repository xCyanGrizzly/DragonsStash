"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Radio,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { IngestionAccountStatus } from "@/lib/telegram/types";

interface WorkerStatusPanelProps {
  initialStatus: IngestionAccountStatus[];
}

const AUTH_STATE_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  PENDING: { label: "Pending", color: "text-yellow-500", icon: "clock" },
  AWAITING_CODE: {
    label: "Awaiting Code",
    color: "text-orange-500",
    icon: "alert",
  },
  AWAITING_PASSWORD: {
    label: "Awaiting Password",
    color: "text-orange-500",
    icon: "alert",
  },
  AUTHENTICATED: { label: "Connected", color: "text-emerald-500", icon: "check" },
  EXPIRED: { label: "Expired", color: "text-red-500", icon: "x" },
};

export function WorkerStatusPanel({ initialStatus }: WorkerStatusPanelProps) {
  const [accounts, setAccounts] = useState(initialStatus);
  const [error, setError] = useState(false);
  const [nextRunCountdown, setNextRunCountdown] = useState<string | null>(null);

  // Find active run
  const activeRun = accounts.find((a) => a.currentRun);
  const isRunning = !!activeRun;

  // Poll for status
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let mounted = true;

    const poll = async () => {
      try {
        const res = await fetch("/api/ingestion/status");
        if (!res.ok) throw new Error("fetch failed");
        const data = await res.json();
        if (mounted) {
          setAccounts(data.accounts ?? []);
          setError(false);
        }
      } catch {
        if (mounted) setError(true);
      }
      if (mounted) {
        const interval = accounts.some((a) => a.currentRun) ? 2_000 : 10_000;
        timer = setTimeout(poll, interval);
      }
    };

    timer = setTimeout(poll, 2_000);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Countdown timer to next run
  useEffect(() => {
    if (isRunning) {
      setNextRunCountdown(null);
      return;
    }

    // Estimate next run based on last run finish time + interval (5 min + up to 5 min jitter)
    const lastFinished = accounts
      .filter((a) => a.lastRun?.finishedAt)
      .map((a) => new Date(a.lastRun!.finishedAt!).getTime())
      .sort((a, b) => b - a)[0];

    if (!lastFinished) {
      setNextRunCountdown(null);
      return;
    }

    const intervalMs = 5 * 60 * 1000; // 5 min base
    const estimatedNext = lastFinished + intervalMs;

    const tick = () => {
      const remaining = estimatedNext - Date.now();
      if (remaining <= 0) {
        setNextRunCountdown("any moment...");
      } else {
        const mins = Math.floor(remaining / 60_000);
        const secs = Math.floor((remaining % 60_000) / 1_000);
        setNextRunCountdown(
          mins > 0 ? `~${mins}m ${secs}s` : `~${secs}s`
        );
      }
    };

    tick();
    const interval = setInterval(tick, 1_000);
    return () => clearInterval(interval);
  }, [isRunning, accounts]);

  if (accounts.length === 0 && !error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-4">
          <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />
          <div>
            <p className="text-sm font-medium">No accounts configured</p>
            <p className="text-xs text-muted-foreground">
              Add a Telegram account below to get started. You&apos;ll need your
              phone number and the API credentials in your .env.local file.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        {/* Account status row */}
        <div className="flex items-center gap-4 flex-wrap">
          {accounts.map((account) => {
            const config = AUTH_STATE_CONFIG[account.authState] ?? AUTH_STATE_CONFIG.PENDING;
            return (
              <div key={account.id} className="flex items-center gap-2">
                {config.icon === "check" && (
                  <CheckCircle2 className={cn("h-4 w-4", config.color)} />
                )}
                {config.icon === "clock" && (
                  <Clock className={cn("h-4 w-4", config.color)} />
                )}
                {config.icon === "alert" && (
                  <AlertTriangle className={cn("h-4 w-4", config.color)} />
                )}
                {config.icon === "x" && (
                  <XCircle className={cn("h-4 w-4", config.color)} />
                )}
                <span className="text-sm font-medium">
                  {account.displayName || account.phone}
                </span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px]", config.color)}
                >
                  {config.label}
                </Badge>
              </div>
            );
          })}
        </div>

        {/* Divider */}
        <div className="border-t" />

        {/* Worker activity */}
        {error ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <XCircle className="h-3.5 w-3.5" />
            <span>Could not reach worker status</span>
          </div>
        ) : isRunning && activeRun?.currentRun ? (
          <RunningStatus run={activeRun.currentRun} />
        ) : (
          <IdleStatus accounts={accounts} nextRunCountdown={nextRunCountdown} />
        )}
      </CardContent>
    </Card>
  );
}

function RunningStatus({
  run,
}: {
  run: NonNullable<IngestionAccountStatus["currentRun"]>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        <span className="text-sm font-medium text-primary truncate">
          {run.currentActivity ?? "Working..."}
        </span>
      </div>

      {/* Progress bar for downloads */}
      {run.downloadPercent != null && run.downloadPercent > 0 && (
        <div className="flex items-center gap-3 pl-6">
          <div className="h-1.5 flex-1 max-w-[200px] rounded-full bg-primary/20">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${Math.min(100, run.downloadPercent)}%` }}
            />
          </div>
          <span className="text-xs text-primary/70 tabular-nums">
            {run.downloadPercent}%
          </span>
        </div>
      )}

      {/* Stats line */}
      <div className="flex items-center gap-4 pl-6 text-xs text-muted-foreground">
        {run.currentChannel && (
          <span>
            Channel: <span className="text-foreground">{run.currentChannel}</span>
          </span>
        )}
        {run.totalFiles != null && run.currentFileNum != null && (
          <span>
            Archive{" "}
            <span className="text-foreground tabular-nums">
              {run.currentFileNum}/{run.totalFiles}
            </span>
          </span>
        )}
        {run.zipsIngested > 0 && (
          <span>
            <span className="text-foreground tabular-nums">{run.zipsIngested}</span> ingested
          </span>
        )}
        {run.zipsDuplicate > 0 && (
          <span>
            <span className="text-foreground tabular-nums">{run.zipsDuplicate}</span> skipped
          </span>
        )}
      </div>
    </div>
  );
}

function IdleStatus({
  accounts,
  nextRunCountdown,
}: {
  accounts: IngestionAccountStatus[];
  nextRunCountdown: string | null;
}) {
  const lastRun = accounts
    .filter((a) => a.lastRun)
    .sort(
      (a, b) =>
        new Date(b.lastRun!.finishedAt ?? b.lastRun!.startedAt).getTime() -
        new Date(a.lastRun!.finishedAt ?? a.lastRun!.startedAt).getTime()
    )[0]?.lastRun;

  const hasAuthenticated = accounts.some(
    (a) => a.authState === "AUTHENTICATED"
  );

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 min-w-0">
        {lastRun ? (
          <>
            {lastRun.status === "FAILED" ? (
              <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            )}
            <span className="text-xs text-muted-foreground truncate">
              {lastRun.status === "FAILED"
                ? `Last sync failed ${getTimeAgo(lastRun.finishedAt ?? lastRun.startedAt)}`
                : `Last sync ${getTimeAgo(lastRun.finishedAt ?? lastRun.startedAt)} — ${lastRun.zipsIngested} new, ${lastRun.zipsDuplicate} skipped, ${lastRun.messagesScanned} messages`}
            </span>
          </>
        ) : hasAuthenticated ? (
          <>
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">
              Waiting for first sync...
            </span>
          </>
        ) : accounts.some((a) => a.authState === "PENDING") ? (
          <>
            <Clock className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
            <span className="text-xs text-muted-foreground">
              Pending account detected — worker will send an SMS code on the next cycle. Please wait...
            </span>
          </>
        ) : accounts.some(
            (a) => a.authState === "AWAITING_CODE" || a.authState === "AWAITING_PASSWORD"
          ) ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 text-orange-500 shrink-0" />
            <span className="text-xs text-muted-foreground">
              Waiting for you to enter the auth code — check the Accounts table below
            </span>
          </>
        ) : (
          <>
            <Radio className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">
              Worker idle — authenticate an account to start syncing
            </span>
          </>
        )}
      </div>

      {nextRunCountdown && hasAuthenticated && (
        <div className="flex items-center gap-1.5 shrink-0">
          <RefreshCw className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground tabular-nums">
            Next: {nextRunCountdown}
          </span>
        </div>
      )}
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
