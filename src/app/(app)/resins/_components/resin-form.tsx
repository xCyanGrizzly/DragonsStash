"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { resinSchema, type ResinInput } from "@/schemas/resin.schema";
import { RESIN_TYPES } from "@/lib/constants";
import { createResin, updateResin } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { ColorSwatch } from "@/components/shared/color-swatch";
import { CatalogBrowserButton } from "@/components/shared/catalog-browser-button";
import { AutocompleteInput } from "@/components/shared/autocomplete-input";
import type { CatalogItem } from "@/types/catalog.types";

interface ResinFormProps {
  resin?: {
    id: string;
    name: string;
    brand: string;
    resinType: string;
    color: string;
    colorHex: string;
    bottleSize: number;
    usedML: number;
    cost: number | null;
    purchaseDate: Date | null;
    notes: string | null;
    vendorId: string | null;
    locationId: string | null;
  };
  vendors: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  onSuccess: () => void;
}

export function ResinForm({ resin, vendors, locations, onSuccess }: ResinFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!resin;

  const form = useForm<ResinInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(resinSchema) as any,
    defaultValues: {
      name: resin?.name ?? "",
      brand: resin?.brand ?? "",
      resinType: (resin?.resinType as ResinInput["resinType"]) ?? "Standard",
      color: resin?.color ?? "",
      colorHex: resin?.colorHex ?? "#000000",
      bottleSize: resin?.bottleSize ?? 500,
      usedML: resin?.usedML ?? 0,
      cost: resin?.cost ?? undefined,
      purchaseDate: resin?.purchaseDate
        ? new Date(resin.purchaseDate).toISOString().split("T")[0]
        : "",
      notes: resin?.notes ?? "",
      vendorId: resin?.vendorId ?? "",
      locationId: resin?.locationId ?? "",
    },
  });

  const watchColorHex = form.watch("colorHex");

  function handleCatalogSelect(item: CatalogItem) {
    form.setValue("name", item.name);
    form.setValue("brand", item.brand);
    if (item.color) form.setValue("color", item.color);
    if (item.colorHex) form.setValue("colorHex", item.colorHex);
    if (item.resinType) {
      const match = RESIN_TYPES.find(
        (t) => t.toUpperCase() === item.resinType!.toUpperCase(),
      );
      if (match) form.setValue("resinType", match);
    }
    if (item.volume) form.setValue("bottleSize", item.volume);
    if (item.price != null) form.setValue("cost", item.price);
  }

  function onSubmit(values: ResinInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateResin(resin!.id, values)
        : await createResin(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Resin updated" : "Resin created");
      form.reset();
      onSuccess();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {!isEditing && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Auto-fill from product catalog
            </p>
            <CatalogBrowserButton type="resin" onSelect={handleCatalogSelect} />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="col-span-2">
                <FormLabel>Name</FormLabel>
                <FormControl>
                  {!isEditing ? (
                    <AutocompleteInput
                      type="resin"
                      value={field.value}
                      onChange={field.onChange}
                      onSelectItem={handleCatalogSelect}
                      placeholder="Resin name — type to search catalog"
                    />
                  ) : (
                    <Input placeholder="Resin name" {...field} />
                  )}
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="brand"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Brand</FormLabel>
                <FormControl>
                  <Input placeholder="Brand name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="resinType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {RESIN_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="color"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Color Name</FormLabel>
                <FormControl>
                  <Input placeholder="e.g. Clear Grey" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="colorHex"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Color Hex</FormLabel>
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Input placeholder="#000000" {...field} className="flex-1" />
                  </FormControl>
                  <input
                    type="color"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    className="h-9 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  />
                  <ColorSwatch hex={watchColorHex || "#000000"} size="md" />
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="bottleSize"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Bottle Size (ml)</FormLabel>
                <FormControl>
                  <Input type="number" step="1" min="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="usedML"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Used (ml)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.1" min="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="vendorId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vendor</FormLabel>
                <Select
                  onValueChange={(val) => field.onChange(val === "none" ? "" : val)}
                  value={field.value || "none"}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select vendor" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="locationId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <Select
                  onValueChange={(val) => field.onChange(val === "none" ? "" : val)}
                  value={field.value || "none"}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select location" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="cost"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cost</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" min="0" placeholder="0.00" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="purchaseDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Purchase Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem className="col-span-2">
                <FormLabel>Notes</FormLabel>
                <FormControl>
                  <Textarea placeholder="Optional notes" rows={2} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : isEditing ? "Update" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
