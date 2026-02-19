"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { logBatchUsage } from "@/app/(app)/usage/actions";
import type { PickerItem } from "@/data/usage.queries";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const ITEM_TYPES = ["FILAMENT", "RESIN", "PAINT", "SUPPLY"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

interface UsageRow {
  id: string;
  itemType: ItemType | "";
  itemId: string;
  amount: string;
  notes: string;
}

function createEmptyRow(): UsageRow {
  return {
    id: crypto.randomUUID(),
    itemType: "",
    itemId: "",
    amount: "",
    notes: "",
  };
}

interface QuickUsageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PickerItem[];
}

export function QuickUsageDialog({ open, onOpenChange, items }: QuickUsageDialogProps) {
  const [rows, setRows] = useState<UsageRow[]>([createEmptyRow()]);
  const [isPending, startTransition] = useTransition();

  function updateRow(id: string, updates: Partial<UsageRow>) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const updated = { ...row, ...updates };
        // Reset itemId when type changes
        if (updates.itemType !== undefined && updates.itemType !== row.itemType) {
          updated.itemId = "";
        }
        return updated;
      })
    );
  }

  function removeRow(id: string) {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((row) => row.id !== id);
    });
  }

  function addRow() {
    setRows((prev) => [...prev, createEmptyRow()]);
  }

  function resetAndClose() {
    setRows([createEmptyRow()]);
    onOpenChange(false);
  }

  function getItemsForType(type: ItemType | "") {
    if (!type) return [];
    return items.filter((item) => item.type === type);
  }

  function getUnit(row: UsageRow): string {
    if (!row.itemId) {
      if (row.itemType === "FILAMENT") return "g";
      if (row.itemType === "RESIN" || row.itemType === "PAINT") return "ml";
      return "";
    }
    const item = items.find((i) => i.id === row.itemId);
    return item?.unit ?? "";
  }

  function isValid(): boolean {
    return rows.every(
      (row) =>
        row.itemType !== "" &&
        row.itemId !== "" &&
        row.amount !== "" &&
        Number(row.amount) > 0
    );
  }

  function handleSubmit() {
    if (!isValid()) return;

    startTransition(async () => {
      const entries = rows.map((row) => ({
        itemType: row.itemType as ItemType,
        itemId: row.itemId,
        amount: Number(row.amount),
        notes: row.notes || undefined,
      }));

      const result = await logBatchUsage({ entries });

      if (!result.success) {
        toast.error(result.error || "Failed to log usage");
        return;
      }

      toast.success(
        entries.length === 1 ? "Usage logged successfully" : `${entries.length} usage entries logged`
      );
      resetAndClose();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log Usage</DialogTitle>
          <DialogDescription>
            Record material consumption for one or more items.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {rows.map((row, index) => {
            const availableItems = getItemsForType(row.itemType);
            const unit = getUnit(row);

            return (
              <div key={row.id} className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Item {index + 1}
                  </span>
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => removeRow(row.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Item Type */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={row.itemType}
                      onValueChange={(value) =>
                        updateRow(row.id, { itemType: value as ItemType })
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        {ITEM_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type.charAt(0) + type.slice(1).toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Item */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Item</Label>
                    <Select
                      value={row.itemId}
                      onValueChange={(value) => updateRow(row.id, { itemId: value })}
                      disabled={!row.itemType}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue
                          placeholder={
                            row.itemType ? "Select item" : "Select type first"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {availableItems.length === 0 ? (
                          <SelectItem value="__empty" disabled>
                            No items available
                          </SelectItem>
                        ) : (
                          availableItems.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Amount */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Amount{unit ? ` (${unit})` : ""}
                    </Label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      placeholder={unit ? `Amount in ${unit}` : "Amount"}
                      value={row.amount}
                      onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                      className="h-9"
                    />
                  </div>

                  {/* Notes */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Notes (optional)</Label>
                    <Input
                      placeholder="What was this used for?"
                      value={row.notes}
                      onChange={(e) => updateRow(row.id, { notes: e.target.value })}
                      className="h-9"
                      maxLength={512}
                    />
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Row */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={addRow}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            Add Another Item
          </Button>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={resetAndClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isPending || !isValid()}
            >
              {isPending
                ? "Logging..."
                : rows.length === 1
                  ? "Log Usage"
                  : `Log ${rows.length} Items`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
