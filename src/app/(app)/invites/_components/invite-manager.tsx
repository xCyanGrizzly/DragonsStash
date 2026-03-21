"use client";

import { useState, useTransition } from "react";
import { Copy, Link2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createInviteCode, createBulkInviteCodes, deleteInviteCode } from "../actions";

type InviteUser = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
};

type InviteCode = {
  id: string;
  code: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  creator: { name: string | null };
  usedBy: InviteUser[];
};

export function InviteManager({
  inviteCodes,
  appUrl,
}: {
  inviteCodes: InviteCode[];
  appUrl: string;
}) {
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [noExpiry, setNoExpiry] = useState(false);
  const [bulkCount, setBulkCount] = useState(5);
  const [isPending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedType, setCopiedType] = useState<"code" | "link" | null>(null);

  function handleCreate() {
    startTransition(async () => {
      await createInviteCode({
        maxUses,
        expiresInDays: noExpiry ? null : expiresInDays,
      });
    });
  }

  function handleBulkCreate() {
    startTransition(async () => {
      await createBulkInviteCodes({
        count: bulkCount,
        maxUses,
        expiresInDays: noExpiry ? null : expiresInDays,
      });
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await deleteInviteCode(id);
    });
  }

  function copyToClipboard(text: string, id: string, type: "code" | "link") {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setCopiedType(type);
    setTimeout(() => {
      setCopiedId(null);
      setCopiedType(null);
    }, 2000);
  }

  function getStatus(invite: InviteCode): "active" | "used" | "expired" {
    if (invite.uses >= invite.maxUses) return "used";
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return "expired";
    return "active";
  }

  function formatRelativeDate(dateStr: string) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "Expired";
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    return `${diffDays} days`;
  }

  const activeCount = inviteCodes.filter((i) => getStatus(i) === "active").length;
  const usedCount = inviteCodes.filter((i) => getStatus(i) === "used").length;

  return (
    <div className="max-w-5xl space-y-6">
      {/* Create Card */}
      <Card>
        <CardHeader>
          <CardTitle>Generate Invite Codes</CardTitle>
          <CardDescription>
            Create single or bulk invite codes to share with new users
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="maxUses">Max Uses</Label>
              <Input
                id="maxUses"
                type="number"
                min={1}
                max={100}
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
                className="w-24"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiresInDays">Expires in (days)</Label>
              <Input
                id="expiresInDays"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
                disabled={noExpiry}
                className="w-24"
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <Switch
                id="noExpiry"
                checked={noExpiry}
                onCheckedChange={setNoExpiry}
              />
              <Label htmlFor="noExpiry" className="text-sm">
                No expiry
              </Label>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <Button onClick={handleCreate} disabled={isPending}>
              <Plus className="mr-2 h-4 w-4" />
              {isPending ? "Creating..." : "Create One"}
            </Button>

            <div className="flex items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="bulkCount">Count</Label>
                <Input
                  id="bulkCount"
                  type="number"
                  min={2}
                  max={25}
                  value={bulkCount}
                  onChange={(e) => setBulkCount(Number(e.target.value))}
                  className="w-20"
                />
              </div>
              <Button
                variant="secondary"
                onClick={handleBulkCreate}
                disabled={isPending}
              >
                <Plus className="mr-2 h-4 w-4" />
                {isPending ? "Creating..." : `Create ${bulkCount}`}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Codes Table */}
      <Card>
        <CardHeader>
          <CardTitle>Invite Codes</CardTitle>
          <CardDescription>
            {inviteCodes.length} total &middot; {activeCount} active &middot; {usedCount} fully used
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inviteCodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No invite codes yet. Create one above.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uses</TableHead>
                  <TableHead>Redeemed By</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inviteCodes.map((invite) => {
                  const status = getStatus(invite);
                  const isCopiedCode =
                    copiedId === invite.id && copiedType === "code";
                  const isCopiedLink =
                    copiedId === invite.id && copiedType === "link";

                  return (
                    <TableRow key={invite.id}>
                      <TableCell className="font-mono text-sm">
                        {invite.code}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            status === "active"
                              ? "default"
                              : status === "used"
                                ? "secondary"
                                : "destructive"
                          }
                        >
                          {status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {invite.uses} / {invite.maxUses}
                      </TableCell>
                      <TableCell>
                        {invite.usedBy.length === 0 ? (
                          <span className="text-muted-foreground">--</span>
                        ) : (
                          <div className="space-y-0.5">
                            {invite.usedBy.map((user) => (
                              <Tooltip key={user.id}>
                                <TooltipTrigger asChild>
                                  <div className="text-sm cursor-default">
                                    {user.name ?? user.email ?? "Unknown"}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <div className="text-xs">
                                    {user.email && <div>{user.email}</div>}
                                    <div>
                                      Joined{" "}
                                      {new Date(user.createdAt).toLocaleDateString()}
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {invite.expiresAt ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">
                                {formatRelativeDate(invite.expiresAt)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {new Date(invite.expiresAt).toLocaleString()}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">
                              {new Date(invite.createdAt).toLocaleDateString()}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            by {invite.creator.name ?? "Unknown"}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  copyToClipboard(
                                    invite.code,
                                    invite.id,
                                    "code"
                                  )
                                }
                              >
                                <Copy className="h-3 w-3" />
                                {isCopiedCode && (
                                  <span className="ml-1">Copied!</span>
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy code</TooltipContent>
                          </Tooltip>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  copyToClipboard(
                                    `${appUrl}/register?code=${invite.code}`,
                                    invite.id,
                                    "link"
                                  )
                                }
                                disabled={status !== "active"}
                              >
                                <Link2 className="h-3 w-3" />
                                {isCopiedLink && (
                                  <span className="ml-1">Copied!</span>
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy registration link</TooltipContent>
                          </Tooltip>

                          <AlertDialog>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    disabled={isPending}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </AlertDialogTrigger>
                              </TooltipTrigger>
                              <TooltipContent>Delete code</TooltipContent>
                            </Tooltip>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Delete invite code?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete the invite code{" "}
                                  <span className="font-mono font-semibold">
                                    {invite.code}
                                  </span>
                                  .{" "}
                                  {status === "active" &&
                                    "Anyone with this code will no longer be able to register."}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDelete(invite.id)}
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
