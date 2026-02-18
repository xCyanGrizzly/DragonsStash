export const APP_NAME = "Dragon's Stash";

export const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { label: "Filaments", href: "/filaments", icon: "Cylinder" },
  { label: "Resins", href: "/resins", icon: "Droplets" },
  { label: "Paints", href: "/paints", icon: "Paintbrush" },
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

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

export const UNITS = ["metric", "imperial"] as const;

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 30, 50] as const;
