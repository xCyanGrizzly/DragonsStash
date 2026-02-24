import { z } from "zod/v4";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listPackagesSchema = paginationSchema.extend({
  channelId: z.string().optional(),
  creator: z.string().optional(),
  sortBy: z.enum(["indexedAt", "fileName", "fileSize"]).default("indexedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const listFilesSchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  extension: z.string().optional(),
});

export const searchSchema = paginationSchema.extend({
  q: z.string().min(1),
  searchIn: z.enum(["packages", "files", "both"]).default("both"),
});

export const triggerIngestionSchema = z.object({
  accountId: z.string().optional(),
});

// ── Account CRUD ──

export const telegramAccountSchema = z.object({
  phone: z
    .string()
    .min(1, "Phone number is required")
    .regex(/^\+?\d[\d\s\-]{6,20}$/, "Invalid phone format (e.g. +31612345678)"),
  displayName: z.string().max(64).optional().or(z.literal("")),
});

export type TelegramAccountInput = z.infer<typeof telegramAccountSchema>;

export const submitAuthCodeSchema = z.object({
  code: z.string().min(3, "Auth code is required").max(10),
});

export type SubmitAuthCodeInput = z.infer<typeof submitAuthCodeSchema>;

export const submitPasswordSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

export type SubmitPasswordInput = z.infer<typeof submitPasswordSchema>;

// ── Channel CRUD ──

export const telegramChannelSchema = z.object({
  telegramId: z.coerce.number().int().min(1, "Telegram ID is required"),
  title: z.string().min(1, "Title is required").max(256),
  type: z.enum(["SOURCE", "DESTINATION"]),
});

export type TelegramChannelInput = z.infer<typeof telegramChannelSchema>;

// ── Account-Channel linking ──

export const linkChannelSchema = z.object({
  accountId: z.string().min(1),
  channelId: z.string().min(1),
  role: z.enum(["READER", "WRITER"]).default("READER"),
});

export type LinkChannelInput = z.infer<typeof linkChannelSchema>;
