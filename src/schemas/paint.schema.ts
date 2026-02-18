import { z } from "zod/v4";
import { PAINT_FINISHES } from "@/lib/constants";

export const paintSchema = z.object({
  name: z.string().min(1, "Name is required").max(128),
  brand: z.string().min(1, "Brand is required").max(64),
  line: z.string().max(64).optional().or(z.literal("")),
  color: z.string().min(1, "Color name is required").max(64),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid hex color"),
  finish: z.enum(PAINT_FINISHES),
  volumeML: z.coerce.number().positive("Volume must be positive"),
  usedML: z.coerce.number().min(0).default(0),
  vendorId: z.string().optional().or(z.literal("")),
  locationId: z.string().optional().or(z.literal("")),
  purchaseDate: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().min(0).optional(),
  notes: z.string().max(1024).optional(),
});

export type PaintInput = z.output<typeof paintSchema>;
