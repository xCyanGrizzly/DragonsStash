import { z } from "zod/v4";
import { CURRENCIES, UNITS } from "@/lib/constants";

export const settingsSchema = z.object({
  lowStockThreshold: z.coerce.number().min(0).max(100).default(10),
  currency: z.enum(CURRENCIES).default("USD"),
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  units: z.enum(UNITS).default("metric"),
});

export type SettingsInput = z.output<typeof settingsSchema>;
