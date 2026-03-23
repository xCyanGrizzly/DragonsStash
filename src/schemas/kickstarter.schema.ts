import { z } from "zod/v4";

export const kickstarterSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  link: z.string().url().optional().or(z.literal("")),
  filesUrl: z.string().url().optional().or(z.literal("")),
  deliveryStatus: z.enum(["NOT_DELIVERED", "PARTIAL", "DELIVERED"]),
  paymentStatus: z.enum(["PAID", "UNPAID"]),
  hostId: z.string().optional().or(z.literal("")),
  notes: z.string().max(2000).optional(),
});

export type KickstarterInput = z.infer<typeof kickstarterSchema>;

export const kickstarterHostSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
});

export type KickstarterHostInput = z.infer<typeof kickstarterHostSchema>;
