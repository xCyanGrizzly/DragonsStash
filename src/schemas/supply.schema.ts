import { z } from "zod/v4";
import { SUPPLY_CATEGORIES } from "@/lib/constants";

export const supplySchema = z.object({
  name: z.string().min(1, "Name is required").max(128),
  brand: z.string().min(1, "Brand is required").max(64),
  category: z.enum(SUPPLY_CATEGORIES),
  color: z.string().max(64).optional().or(z.literal("")),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid hex color").optional().or(z.literal("")),
  totalAmount: z.coerce.number().positive("Total amount must be positive"),
  usedAmount: z.coerce.number().min(0).default(0),
  unit: z.string().min(1, "Unit is required").max(16),
  vendorId: z.string().optional().or(z.literal("")),
  locationId: z.string().optional().or(z.literal("")),
  purchaseDate: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().min(0).optional(),
  notes: z.string().max(1024).optional(),
});

export type SupplyInput = z.output<typeof supplySchema>;
