"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuickUsageDialog } from "@/components/shared/quick-usage-dialog";
import type { PickerItem } from "@/data/usage.queries";

interface RecentUsage {
  id: string;
  itemType: string;
  amount: number;
  unit: string;
  notes: string | null;
  createdAt: string;
  itemName: string;
}

interface RecentUsageCardProps {
  recentUsage: RecentUsage[];
  items: PickerItem[];
}

export function RecentUsageCard({ recentUsage, items }: RecentUsageCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Recent Usage</CardTitle>
              <CardDescription>Latest consumption log entries</CardDescription>
            </div>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Log Usage
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {recentUsage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage logged yet.</p>
          ) : (
            <div className="space-y-3">
              {recentUsage.map((log) => (
                <div key={log.id} className="flex items-center gap-3">
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {log.itemType}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{log.itemName}</p>
                    <p className="text-xs text-muted-foreground">
                      {log.notes || "No notes"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-medium">
                      -{log.amount}{log.unit}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <QuickUsageDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        items={items}
      />
    </>
  );
}
