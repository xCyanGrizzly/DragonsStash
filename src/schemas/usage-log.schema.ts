import { z } from "zod/v4";

export const usageLogSchema = z.object({
  amount: z.coerce.number().positive("Amount must be positive"),
  notes: z.string().max(512).optional(),
});

export type UsageLogInput = z.output<typeof usageLogSchema>;
