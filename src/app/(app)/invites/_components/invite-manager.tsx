"use client";

import { useState, useTransition } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { createInviteCode, deleteInviteCode } from "../actions";

type InviteCode = {
  id: string;
  code: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  creator: { name: string | null };
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
  const [isPending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function handleCreate() {
    startTransition(async () => {
      await createInviteCode({
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

  function copyLink(code: string, id: string) {
    const url = `${appUrl}/register?code=${code}`;
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function getStatus(invite: InviteCode) {
    if (invite.uses >= invite.maxUses) return "used";
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return "expired";
    return "active";
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Create Invite Code</CardTitle>
          <CardDescription>
            Generate a new invite code to share with someone
          </CardDescription>
        </CardHeader>
        <CardContent>
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
              <Label htmlFor="expiresInDays">
                Expires in (days)
              </Label>
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
              <input
                type="checkbox"
                id="noExpiry"
                checked={noExpiry}
                onChange={(e) => setNoExpiry(e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="noExpiry" className="text-sm">No expiry</Label>
            </div>
            <Button onClick={handleCreate} disabled={isPending}>
              <Plus className="mr-2 h-4 w-4" />
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite Codes</CardTitle>
          <CardDescription>
            {inviteCodes.length} invite code{inviteCodes.length !== 1 ? "s" : ""} created
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
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inviteCodes.map((invite) => {
                  const status = getStatus(invite);
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
                        {invite.expiresAt
                          ? new Date(invite.expiresAt).toLocaleDateString()
                          : "Never"}
                      </TableCell>
                      <TableCell>
                        {new Date(invite.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyLink(invite.code, invite.id)}
                            disabled={status !== "active"}
                          >
                            <Copy className="mr-1 h-3 w-3" />
                            {copiedId === invite.id ? "Copied!" : "Copy Link"}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDelete(invite.id)}
                            disabled={isPending}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
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
