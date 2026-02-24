"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle, CloudOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IngestionAccountStatus } from "@/lib/telegram/types";

interface IngestionStatusProps {
  initialStatus: IngestionAccountStatus[];
}

/**
 * Polls /api/ingestion/status every 3 seconds while a run is active,
 * or every 30 seconds when idle. Shows a compact status banner with
 * a spinning throbber when ingestion is running.
 */
export function IngestionStatus({ initialStatus }: IngestionStatusProps) {
  const [accounts, setAccounts] = useState(initialStatus);
  const [error, setError] = useState(false);

  // Determine if any account is currently running
  const activeRun = accounts.find((a) => a.currentRun);
  const isRunning = !!activeRun;

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
        // Poll fast while running, slow when idle
        const interval = accounts.some((a) => a.currentRun) ? 3_000 : 30_000;
        timer = setTimeout(poll, interval);
      }
    };

    // Start polling after a short delay to avoid double-fetching on mount
    timer = setTimeout(poll, 3_000);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Nothing to show if no accounts configured
  if (accounts.length === 0 && !error) return null;

  // If we can't reach the API, show a muted offline badge
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <CloudOff className="h-3.5 w-3.5" />
        <span>Sync status unavailable</span>
      </div>
    );
  }

  // Active run — show throbber with live activity
  if (activeRun?.currentRun) {
    const run = activeRun.currentRun;
    return (
      <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-primary">
            {run.currentActivity ?? "Syncing..."}
          </p>
          {run.downloadPercent != null && run.downloadPercent > 0 && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 w-24 rounded-full bg-primary/20">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.min(100, run.downloadPercent)}%` }}
                />
              </div>
              <span className="text-[10px] text-primary/70">{run.downloadPercent}%</span>
            </div>
          )}
        </div>
        {run.totalFiles != null && run.currentFileNum != null && (
          <span className="shrink-0 text-[10px] text-primary/60">
            {run.currentFileNum}/{run.totalFiles}
          </span>
        )}
      </div>
    );
  }

  // All idle — show last run summary
  const lastCompleted = accounts
    .filter((a) => a.lastRun)
    .sort(
      (a, b) =>
        new Date(b.lastRun!.finishedAt ?? b.lastRun!.startedAt).getTime() -
        new Date(a.lastRun!.finishedAt ?? a.lastRun!.startedAt).getTime()
    )[0];

  if (!lastCompleted?.lastRun) return null;

  const last = lastCompleted.lastRun;
  const isFailed = last.status === "FAILED";
  const timeAgo = getTimeAgo(last.finishedAt ?? last.startedAt);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        isFailed
          ? "border-red-500/20 bg-red-500/5 text-red-400"
          : "border-border bg-card text-muted-foreground"
      )}
    >
      {isFailed ? (
        <XCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      )}
      <span className="truncate">
        {isFailed
          ? `Last sync failed ${timeAgo}`
          : `Last sync ${timeAgo} — ${last.zipsIngested} new, ${last.zipsDuplicate} skipped`}
      </span>
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
