export const APP_NAME = "Dragon's Stash";

export const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard", adminOnly: false },
  { label: "Filaments", href: "/filaments", icon: "Cylinder", adminOnly: false },
  { label: "Resins", href: "/resins", icon: "Droplets", adminOnly: false },
  { label: "Paints", href: "/paints", icon: "Paintbrush", adminOnly: false },
  { label: "Supplies", href: "/supplies", icon: "Gem", adminOnly: false },
  { label: "STL Files", href: "/stls", icon: "FileBox", adminOnly: false },
  { label: "Telegram", href: "/telegram", icon: "Send", adminOnly: true },
  { label: "Usage", href: "/usage", icon: "ClipboardList", adminOnly: false },
  { label: "Vendors", href: "/vendors", icon: "Building2", adminOnly: false },
  { label: "Locations", href: "/locations", icon: "MapPin", adminOnly: false },
  { label: "Settings", href: "/settings", icon: "Settings", adminOnly: false },
] as const;

export const MATERIALS = [
  "PLA",
  "PETG",
  "ABS",
  "TPU",
  "ASA",
  "Nylon",
  "PC",
  "PVA",
  "HIPS",
  "Other",
] as const;

export const RESIN_TYPES = [
  "Standard",
  "ABS-Like",
  "Water-Washable",
  "Flexible",
  "Tough",
  "Dental",
  "Castable",
  "Other",
] as const;

export const PAINT_FINISHES = [
  "Matte",
  "Satin",
  "Gloss",
  "Metallic",
  "Wash",
  "Contrast",
  "Ink",
  "Primer",
  "Varnish",
  "Other",
] as const;

export const SUPPLY_CATEGORIES = [
  "Glitter",
  "Alcohol Ink",
  "Mica Powder",
  "Pigment",
  "Silicone",
  "Resin Additive",
  "Sanding/Polishing",
  "Mold",
  "Other",
] as const;

export const SUPPLY_UNITS = ["g", "ml", "sheets", "pieces", "oz"] as const;

export const SUPPLY_CATEGORY_DEFAULTS: Record<string, { unit: string; totalAmount: number }> = {
  "Glitter":           { unit: "g",      totalAmount: 50 },
  "Alcohol Ink":       { unit: "ml",     totalAmount: 15 },
  "Mica Powder":       { unit: "g",      totalAmount: 25 },
  "Pigment":           { unit: "g",      totalAmount: 25 },
  "Silicone":          { unit: "ml",     totalAmount: 500 },
  "Resin Additive":    { unit: "ml",     totalAmount: 100 },
  "Sanding/Polishing": { unit: "sheets", totalAmount: 10 },
  "Mold":              { unit: "pieces", totalAmount: 1 },
  "Other":             { unit: "g",      totalAmount: 100 },
};

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

export const UNITS = ["metric", "imperial"] as const;

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 30, 50] as const;
