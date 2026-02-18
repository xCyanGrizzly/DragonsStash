import { z } from "zod/v4";
import { MATERIALS } from "@/lib/constants";

export const filamentSchema = z.object({
  name: z.string().min(1, "Name is required").max(128),
  brand: z.string().min(1, "Brand is required").max(64),
  material: z.enum(MATERIALS),
  color: z.string().min(1, "Color name is required").max(64),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid hex color"),
  diameter: z.coerce.number().positive().default(1.75),
  spoolWeight: z.coerce.number().positive("Spool weight must be positive"),
  usedWeight: z.coerce.number().min(0).default(0),
  emptySpoolWeight: z.coerce.number().min(0).default(0),
  vendorId: z.string().optional().or(z.literal("")),
  locationId: z.string().optional().or(z.literal("")),
  purchaseDate: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().min(0).optional(),
  notes: z.string().max(1024).optional(),
});

export type FilamentInput = z.output<typeof filamentSchema>;
