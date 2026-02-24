"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  telegramChannelSchema,
  type TelegramChannelInput,
} from "@/schemas/telegram";
import { createChannel, updateChannel } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import type { ChannelRow } from "@/lib/telegram/admin-queries";

interface ChannelFormProps {
  channel?: ChannelRow;
  onSuccess: () => void;
}

export function ChannelForm({ channel, onSuccess }: ChannelFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!channel;

  const form = useForm<TelegramChannelInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(telegramChannelSchema) as any,
    defaultValues: {
      telegramId: channel ? Number(channel.telegramId) : (0 as unknown as number),
      title: channel?.title ?? "",
      type: channel?.type ?? "SOURCE",
    },
  });

  function onSubmit(values: TelegramChannelInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateChannel(channel!.id, values)
        : await createChannel(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Channel updated" : "Channel created");
      form.reset();
      onSuccess();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder="Channel name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="telegramId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Telegram ID</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="1234567890"
                  {...field}
                  value={field.value || ""}
                />
              </FormControl>
              <FormDescription>
                Numeric ID of the Telegram channel or group
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Type</FormLabel>
              <Select
                onValueChange={field.onChange}
                defaultValue={field.value}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="SOURCE">Source (read archives)</SelectItem>
                  <SelectItem value="DESTINATION">
                    Destination (forward indexed)
                  </SelectItem>
                </SelectContent>
              </Select>
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
