"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { supplySchema, type SupplyInput } from "@/schemas/supply.schema";
import { SUPPLY_CATEGORIES, SUPPLY_UNITS, SUPPLY_CATEGORY_DEFAULTS } from "@/lib/constants";
import { createSupply, updateSupply } from "../actions";
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

interface SupplyFormProps {
  supply?: {
    id: string;
    name: string;
    brand: string;
    category: string;
    color: string | null;
    colorHex: string | null;
    totalAmount: number;
    usedAmount: number;
    unit: string;
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

export function SupplyForm({ supply, vendors, locations, onSuccess }: SupplyFormProps) {
  const [isPending, startTransition] = useTransition();
  const isEditing = !!supply;

  const form = useForm<SupplyInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(supplySchema) as any,
    defaultValues: {
      name: supply?.name ?? "",
      brand: supply?.brand ?? "",
      category: (supply?.category as SupplyInput["category"]) ?? "Glitter",
      color: supply?.color ?? "",
      colorHex: supply?.colorHex ?? "",
      totalAmount: supply?.totalAmount ?? SUPPLY_CATEGORY_DEFAULTS["Glitter"].totalAmount,
      usedAmount: supply?.usedAmount ?? 0,
      unit: supply?.unit ?? SUPPLY_CATEGORY_DEFAULTS["Glitter"].unit,
      cost: supply?.cost ?? undefined,
      purchaseDate: supply?.purchaseDate
        ? new Date(supply.purchaseDate).toISOString().split("T")[0]
        : "",
      notes: supply?.notes ?? "",
      vendorId: supply?.vendorId ?? "",
      locationId: supply?.locationId ?? "",
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch is safe here
  const watchColorHex = form.watch("colorHex");
  // eslint-disable-next-line react-hooks/incompatible-library
  const watchUnit = form.watch("unit");

  function onSubmit(values: SupplyInput) {
    startTransition(async () => {
      const result = isEditing
        ? await updateSupply(supply!.id, values)
        : await createSupply(values);

      if (!result.success) {
        toast.error(result.error);
        return;
      }

      toast.success(isEditing ? "Supply updated" : "Supply created");
      form.reset();
      onSuccess();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="col-span-2">
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input placeholder="Supply name" {...field} />
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
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                <Select
                  onValueChange={(val) => {
                    field.onChange(val);
                    if (!isEditing) {
                      const defaults = SUPPLY_CATEGORY_DEFAULTS[val];
                      if (defaults) {
                        form.setValue("unit", defaults.unit);
                        form.setValue("totalAmount", defaults.totalAmount);
                      }
                    }
                  }}
                  value={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SUPPLY_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
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
                <FormLabel>Color (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="e.g. Rose Gold" {...field} />
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
                <FormLabel>Color Hex (optional)</FormLabel>
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Input placeholder="#000000" {...field} className="flex-1" />
                  </FormControl>
                  <input
                    type="color"
                    value={field.value || "#000000"}
                    onChange={(e) => field.onChange(e.target.value)}
                    className="h-9 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  />
                  {watchColorHex && (
                    <ColorSwatch hex={watchColorHex} size="md" />
                  )}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="totalAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Total Amount ({watchUnit || "units"})</FormLabel>
                <FormControl>
                  <Input type="number" step="0.1" min="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="usedAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Used ({watchUnit || "units"})</FormLabel>
                <FormControl>
                  <Input type="number" step="0.1" min="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="unit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Unit</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select unit" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SUPPLY_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
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
