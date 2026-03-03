"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Send } from "lucide-react";
import type { SendHistoryRow } from "@/types/telegram.types";

interface BotSendsTabProps {
  history: SendHistoryRow[];
}

function statusBadge(status: string) {
  switch (status) {
    case "SENT":
      return <Badge variant="default" className="bg-green-600">Sent</Badge>;
    case "SENDING":
      return <Badge variant="secondary">Sending</Badge>;
    case "PENDING":
      return <Badge variant="outline">Pending</Badge>;
    case "FAILED":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function BotSendsTab({ history }: BotSendsTabProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Send className="h-5 w-5 text-primary" />
          <CardTitle>Bot Send History</CardTitle>
        </div>
        <CardDescription>
          Recent package deliveries via the Telegram bot.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
            <Send className="h-6 w-6 text-muted-foreground/50" />
            No sends yet. Use the &ldquo;Send to Telegram&rdquo; button on a
            package to get started.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-[200px] truncate font-medium">
                      {row.packageName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.recipientName ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {statusBadge(row.status)}
                        {row.error && (
                          <span
                            className="text-xs text-destructive truncate max-w-[150px]"
                            title={row.error}
                          >
                            {row.error}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {row.completedAt
                        ? new Date(row.completedAt).toLocaleString()
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
