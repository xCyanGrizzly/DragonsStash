"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { vendorSchema, type VendorInput } from "@/schemas/vendor.schema";
import { createVendor, updateVendor } from "../actions";
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

interface VendorFormProps {
  vendor?: { id: string; name: string; website: string | null; notes: string | null };
  onSuccess: () => void;
}

export function VendorForm({ vendor, onSuccess }: VendorFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!vendor;

  const form = useForm<VendorInput>({
    resolver: zodResolver(vendorSchema),
    defaultValues: {
      name: vendor?.name ?? "",
      website: vendor?.website ?? "",
      notes: vendor?.notes ?? "",
    },
  });

  function onSubmit(values: VendorInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateVendor(vendor!.id, values)
        : await createVendor(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Vendor updated" : "Vendor created");
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
                <Input placeholder="Vendor name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="website"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Website</FormLabel>
              <FormControl>
                <Input placeholder="https://example.com" {...field} />
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
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea placeholder="Optional notes" rows={3} {...field} />
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
