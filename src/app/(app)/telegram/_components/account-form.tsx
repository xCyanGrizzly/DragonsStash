"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  telegramAccountSchema,
  type TelegramAccountInput,
} from "@/schemas/telegram";
import { createAccount, updateAccount } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import type { AccountRow } from "@/lib/telegram/admin-queries";

interface AccountFormProps {
  account?: AccountRow;
  onSuccess: () => void;
}

export function AccountForm({ account, onSuccess }: AccountFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!account;

  const form = useForm<TelegramAccountInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(telegramAccountSchema) as any,
    defaultValues: {
      phone: account?.phone ?? "",
      displayName: account?.displayName ?? "",
    },
  });

  function onSubmit(values: TelegramAccountInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateAccount(account!.id, values)
        : await createAccount(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Account updated" : "Account created");
      form.reset();
      onSuccess();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone Number</FormLabel>
              <FormControl>
                <Input placeholder="+31612345678" {...field} />
              </FormControl>
              <FormDescription>
                International format with country code
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display Name</FormLabel>
              <FormControl>
                <Input placeholder="My Bot Account" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : isEditing ? "Update" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
