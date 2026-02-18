"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { filamentSchema, type FilamentInput } from "@/schemas/filament.schema";
import { MATERIALS } from "@/lib/constants";
import { createFilament, updateFilament } from "../actions";
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

interface FilamentFormProps {
  filament?: {
    id: string;
    name: string;
    brand: string;
    material: string;
    color: string;
    colorHex: string;
    diameter: number;
    spoolWeight: number;
    usedWeight: number;
    emptySpoolWeight: number;
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

export function FilamentForm({ filament, vendors, locations, onSuccess }: FilamentFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!filament;

  const form = useForm<FilamentInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(filamentSchema) as any,
    defaultValues: {
      name: filament?.name ?? "",
      brand: filament?.brand ?? "",
      material: (filament?.material as FilamentInput["material"]) ?? "PLA",
      color: filament?.color ?? "",
      colorHex: filament?.colorHex ?? "#000000",
      diameter: filament?.diameter ?? 1.75,
      spoolWeight: filament?.spoolWeight ?? 1000,
      usedWeight: filament?.usedWeight ?? 0,
      emptySpoolWeight: filament?.emptySpoolWeight ?? 0,
      cost: filament?.cost ?? undefined,
      purchaseDate: filament?.purchaseDate
        ? new Date(filament.purchaseDate).toISOString().split("T")[0]
        : "",
      notes: filament?.notes ?? "",
      vendorId: filament?.vendorId ?? "",
      locationId: filament?.locationId ?? "",
    },
  });

  const watchColorHex = form.watch("colorHex");

  function handleCatalogSelect(item: CatalogItem) {
    form.setValue("name", item.name);
    form.setValue("brand", item.brand);
    if (item.color) form.setValue("color", item.color);
    if (item.colorHex) form.setValue("colorHex", item.colorHex);
    if (item.material) {
      const match = MATERIALS.find(
        (m) => m.toUpperCase() === item.material!.toUpperCase(),
      );
      if (match) form.setValue("material", match);
    }
    if (item.weight) form.setValue("spoolWeight", item.weight);
    if (item.price != null) form.setValue("cost", item.price);
  }

  function onSubmit(values: FilamentInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateFilament(filament!.id, values)
        : await createFilament(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Filament updated" : "Filament created");
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
            <CatalogBrowserButton type="filament" onSelect={handleCatalogSelect} />
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
                      type="filament"
                      value={field.value}
                      onChange={field.onChange}
                      onSelectItem={handleCatalogSelect}
                      placeholder="Filament name — type to search catalog"
                    />
                  ) : (
                    <Input placeholder="Filament name" {...field} />
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
            name="material"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Material</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select material" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {MATERIALS.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
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
                  <Input placeholder="e.g. Galaxy Black" {...field} />
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
            name="spoolWeight"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Spool Weight (g)</FormLabel>
                <FormControl>
                  <Input type="number" step="1" min="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="usedWeight"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Used Weight (g)</FormLabel>
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
                      <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
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
                      <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
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
