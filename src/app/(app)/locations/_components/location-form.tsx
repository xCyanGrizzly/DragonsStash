"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { locationSchema, type LocationInput } from "@/schemas/location.schema";
import { createLocation, updateLocation } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

interface LocationFormProps {
  location?: { id: string; name: string; description: string | null };
  onSuccess: () => void;
}

export function LocationForm({ location, onSuccess }: LocationFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!location;

  const form = useForm<LocationInput>({
    resolver: zodResolver(locationSchema),
    defaultValues: {
      name: location?.name ?? "",
      description: location?.description ?? "",
    },
  });

  function onSubmit(values: LocationInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateLocation(location!.id, values)
        : await createLocation(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Location updated" : "Location created");
      form.reset();
      onSuccess();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Location name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea placeholder="Optional description" rows={3} {...field} />
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
