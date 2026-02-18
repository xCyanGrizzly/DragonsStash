"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v4";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

const usageSchema = z.object({
  amount: z.coerce.number().positive("Amount must be positive"),
  notes: z.string().max(512).optional(),
});

type UsageInput = z.infer<typeof usageSchema>;

interface UsageLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemName: string;
  unit: string;
  onSubmit: (amount: number, notes?: string) => Promise<{ success: boolean; error?: string }>;
}

export function UsageLogDialog({
  open,
  onOpenChange,
  itemName,
  unit,
  onSubmit,
}: UsageLogDialogProps) {
  const [isPending, startTransition] = useTransition();

  const form = useForm<UsageInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(usageSchema) as any,
    defaultValues: { amount: 0, notes: "" },
  });

  function handleSubmit(values: UsageInput) {
    startTransition(async () => {
      const result = await onSubmit(values.amount, values.notes);

      if (!result.success) {
        toast.error(result.error || "Failed to log usage");
        return;
      }

      toast.success("Usage logged successfully");
      form.reset();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Usage</DialogTitle>
          <DialogDescription>
            Record usage for {itemName}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount ({unit})</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      placeholder={`Amount in ${unit}`}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What was this used for?"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Logging..." : "Log Usage"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
