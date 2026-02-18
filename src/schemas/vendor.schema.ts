import { z } from "zod/v4";

export const vendorSchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
  website: z.string().url().optional().or(z.literal("")),
  notes: z.string().max(1024).optional(),
});

export type VendorInput = z.infer<typeof vendorSchema>;
