import { z } from "zod/v4";

export const locationSchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
  description: z.string().max(256).optional(),
});

export type LocationInput = z.infer<typeof locationSchema>;
