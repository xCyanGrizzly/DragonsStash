export const APP_NAME = "Dragon's Stash";

export const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { label: "Filaments", href: "/filaments", icon: "Cylinder" },
  { label: "Resins", href: "/resins", icon: "Droplets" },
  { label: "Paints", href: "/paints", icon: "Paintbrush" },
  { label: "Supplies", href: "/supplies", icon: "Gem" },
  { label: "Vendors", href: "/vendors", icon: "Building2" },
  { label: "Locations", href: "/locations", icon: "MapPin" },
  { label: "Settings", href: "/settings", icon: "Settings" },
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
