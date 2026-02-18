/**
 * Fetches and normalises product data from Shopify stores.
 *
 * Shopify exposes /products.json (and /collections/{handle}/products.json)
 * as a public JSON API — no auth required.
 */

import type { CatalogItem } from "@/types/catalog.types";
import { cachedFetch } from "./cache";

// ────────────────────── Shopify raw types ──────────────────────

interface ShopifyImage {
  src: string;
}

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

// ────────────────────── Known colour hex map ──────────────────────

const COLOR_HEX_MAP: Record<string, string> = {
  white: "#FFFFFF",
  black: "#000000",
  red: "#E53935",
  blue: "#1E88E5",
  green: "#43A047",
  yellow: "#FDD835",
  orange: "#FB8C00",
  purple: "#8E24AA",
  pink: "#D81B60",
  grey: "#9E9E9E",
  gray: "#9E9E9E",
  transparent: "#F5F5F5",
  clear: "#F5F5F5",
  silver: "#BDBDBD",
  gold: "#FFD600",
  beige: "#D7CCC8",
  brown: "#6D4C41",
  navy: "#1A237E",
  "space gray": "#616161",
  "sky blue": "#4FC3F7",
};

function guessHex(colorName: string): string | undefined {
  const lower = colorName.toLowerCase().trim();
  if (COLOR_HEX_MAP[lower]) return COLOR_HEX_MAP[lower];

  // Partial match
  for (const [key, hex] of Object.entries(COLOR_HEX_MAP)) {
    if (lower.includes(key)) return hex;
  }
  return undefined;
}

// ────────────────────── Fetch helpers ──────────────────────

async function fetchShopifyProducts(
  baseUrl: string,
  collectionPath?: string,
): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let page = 1;
  const limit = 250;
  const maxPages = 5; // Safety cap

  while (page <= maxPages) {
    const path = collectionPath
      ? `${baseUrl}/collections/${collectionPath}/products.json`
      : `${baseUrl}/products.json`;
    const url = `${path}?limit=${limit}&page=${page}`;

    // 10-second timeout per request
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        console.warn(`Shopify fetch failed: ${url} → ${resp.status}`);
        break;
      }

      const json = (await resp.json()) as ShopifyProductsResponse;
      if (!json.products || json.products.length === 0) break;

      products.push(...json.products);

      // Shopify caps at 250/page — if we got less, we're done
      if (json.products.length < limit) break;
      page++;
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`Shopify fetch error for ${url}:`, err instanceof Error ? err.message : err);
      break;
    }
  }

  return products;
}

// ────────────────────── Normalisers ──────────────────────

const KNOWN_MATERIALS = ["PLA", "PETG", "ABS", "TPU", "ASA", "SILK", "WOOD", "CARBON", "NYLON", "PC", "PVA", "HIPS"];

function normaliseFilament(
  product: ShopifyProduct,
  storeUrl: string,
): CatalogItem[] {
  const brand = product.vendor || "Unknown";
  const image = product.images[0]?.src;

  // Guess material from product title / tags
  const titleUpper = product.title.toUpperCase();
  const material = KNOWN_MATERIALS.find((m) => titleUpper.includes(m));

  return product.variants.map((v) => {
    // Use Shopify option fields when available (more reliable than splitting title)
    // Common patterns: option1=material option2=color, or option1=color option2=size
    let colorName: string | undefined;
    let weightStr = "";

    if (v.option2 && v.option1) {
      // If option1 looks like a material, option2 is the color
      const opt1Upper = v.option1.toUpperCase();
      const opt1IsMaterial = KNOWN_MATERIALS.some((m) => opt1Upper.includes(m));
      if (opt1IsMaterial) {
        colorName = v.option2;
      } else {
        colorName = v.option1;
        weightStr = v.option2;
      }
    } else if (v.option1) {
      colorName = v.option1;
    }

    // Fallback: split variant title on "/"
    if (!colorName || colorName === "Default Title") {
      const parts = v.title.split("/").map((s) => s.trim());
      colorName = parts.length > 1 ? parts[1] : parts[0];
      if (!weightStr && parts.length > 2) weightStr = parts[2];
    }

    // Try to parse weight in grams
    let weight: number | undefined;
    const allText = `${v.title} ${v.option2 || ""} ${v.option3 || ""}`;
    const kgMatch = allText.match(/([\d.]+)\s*kg/i);
    const gMatch = allText.match(/([\d.]+)\s*g(?!f)/i); // avoid matching "gf" in PETG-GF
    if (kgMatch) weight = parseFloat(kgMatch[1]) * 1000;
    else if (gMatch) weight = parseFloat(gMatch[1]);

    const displayName = `${product.title} — ${colorName}`;
    const price = parseFloat(v.price) || undefined;
    const hex = guessHex(colorName);

    const id = `filament-${brand}-${v.id}`.replace(/[^a-zA-Z0-9-]/g, "_").toLowerCase();

    return {
      id,
      name: displayName,
      brand,
      type: "filament" as const,
      color: colorName,
      colorHex: hex,
      material: material ?? undefined,
      weight,
      price,
      currency: "USD",
      imageUrl: image,
      productCode: v.sku || undefined,
      sourceUrl: `${storeUrl}/products/${product.handle}`,
    } satisfies CatalogItem;
  });
}

function normaliseResin(
  product: ShopifyProduct,
  storeUrl: string,
): CatalogItem[] {
  const brand = product.vendor || "Unknown";
  const image = product.images[0]?.src;

  // Guess resin type from title
  const titleLower = product.title.toLowerCase();
  let resinType: string | undefined;
  if (titleLower.includes("abs-like") || titleLower.includes("abs like")) {
    resinType = "ABS-Like";
  } else if (titleLower.includes("water washable") || titleLower.includes("water-washable")) {
    resinType = "Water-Washable";
  } else if (titleLower.includes("plant-based") || titleLower.includes("plant based")) {
    resinType = "Plant-Based";
  } else if (titleLower.includes("tough")) {
    resinType = "Tough";
  } else if (titleLower.includes("flexible")) {
    resinType = "Flexible";
  } else if (titleLower.includes("dental")) {
    resinType = "Dental";
  } else if (titleLower.includes("castable")) {
    resinType = "Castable";
  } else if (titleLower.includes("high temp")) {
    resinType = "High-Temp";
  } else {
    resinType = "Standard";
  }

  return product.variants.map((v) => {
    // Extract color from Shopify option fields.
    // Patterns seen:
    //   Elegoo:      option1="1KG"  option2="#Space Grey"   (size, color with # prefix)
    //   Elegoo:      option1="#Grey" option2=null            (color only, # prefix)
    //   Siraya Tech: option1="US"   option2="1KG*12"  option3="Sonic Grey" (region, size, color)
    let colorName: string | undefined;

    // Helper: strip leading "#" that Elegoo uses as a prefix for color names
    const stripHash = (s: string) => s.startsWith("#") ? s.slice(1).trim() : s.trim();

    // Helper: check if a string looks like a size/weight (e.g. "1KG", "500g", "2KG*12")
    const isSize = (s: string) => /^\d+(\.\d+)?\s*(kg|g|ml|l)\b/i.test(s.replace(/\*/g, " "));

    // Helper: check if a string looks like a region code (e.g. "US", "EU", "UK")
    const isRegion = (s: string) => /^[A-Z]{2,3}$/.test(s.trim());

    if (v.option3) {
      // 3-option pattern: region / size / color (Siraya Tech)
      colorName = v.option3;
    } else if (v.option2) {
      // 2-option pattern: size / color OR color / size (Elegoo)
      const opt1 = v.option1 || "";
      const opt2 = v.option2 || "";
      if (isSize(opt1) || isRegion(opt1)) {
        colorName = stripHash(opt2);
      } else {
        colorName = stripHash(opt1);
      }
    } else if (v.option1) {
      colorName = stripHash(v.option1);
    }

    // Fallback: split variant title on "/"
    if (!colorName || colorName === "Default Title") {
      const parts = v.title.split("/").map((s) => s.trim());
      // Pick the last non-size part as color
      colorName = parts.filter((p) => !isSize(p) && !isRegion(p)).pop() || parts[0];
      if (colorName) colorName = stripHash(colorName);
    }

    if (!colorName) colorName = product.title;

    // Volume: look across all text for size info
    const allText = `${v.title} ${v.option1 || ""} ${v.option2 || ""} ${v.option3 || ""}`;
    let volume: number | undefined;
    const mlMatch = allText.match(/([\d.]+)\s*ml/i);
    const lMatch = allText.match(/([\d.]+)\s*l(?:iter)?/i);
    const kgMatch = allText.match(/([\d.]+)\s*kg/i);
    const gMatch = allText.match(/([\d.]+)\s*g(?!f)/i);
    if (mlMatch) volume = parseFloat(mlMatch[1]);
    else if (lMatch) volume = parseFloat(lMatch[1]) * 1000;
    else if (kgMatch) volume = parseFloat(kgMatch[1]) * 1000;
    else if (gMatch) volume = parseFloat(gMatch[1]);

    const displayName = `${product.title} — ${colorName}`;
    const price = parseFloat(v.price) || undefined;
    const hex = guessHex(colorName);

    const id = `resin-${brand}-${v.id}`.replace(/[^a-zA-Z0-9-]/g, "_").toLowerCase();

    return {
      id,
      name: displayName,
      brand,
      type: "resin" as const,
      color: colorName,
      colorHex: hex,
      resinType,
      volume,
      price,
      currency: "USD",
      imageUrl: image,
      productCode: v.sku || undefined,
      sourceUrl: `${storeUrl}/products/${product.handle}`,
    } satisfies CatalogItem;
  });
}

// ────────────────────── Public API ──────────────────────

export async function fetchFilaments(): Promise<CatalogItem[]> {
  return cachedFetch("catalog:filaments", async () => {
    const [elegoo, siraya] = await Promise.all([
      fetchShopifyProducts("https://us.elegoo.com", "filaments").catch(() => []),
      fetchShopifyProducts("https://siraya.tech").catch(() => []),
    ]);

    const items: CatalogItem[] = [];

    for (const p of elegoo) {
      items.push(...normaliseFilament(p, "https://us.elegoo.com"));
    }

    // Siraya Tech sells both resins and filaments — filter by tags/type
    for (const p of siraya) {
      const isFilament =
        p.product_type?.toLowerCase().includes("filament") ||
        p.tags.some((t) => t.toLowerCase().includes("filament")) ||
        p.title.toLowerCase().includes("filament");
      if (isFilament) {
        items.push(...normaliseFilament(p, "https://siraya.tech"));
      }
    }

    return items;
  });
}

export async function fetchResins(): Promise<CatalogItem[]> {
  return cachedFetch("catalog:resins", async () => {
    const [elegoo, siraya] = await Promise.all([
      fetchShopifyProducts("https://us.elegoo.com", "standard-resins").catch(
        () => [],
      ),
      fetchShopifyProducts("https://siraya.tech").catch(() => []),
    ]);

    const items: CatalogItem[] = [];

    for (const p of elegoo) {
      items.push(...normaliseResin(p, "https://us.elegoo.com"));
    }

    // Siraya Tech — filter for resins
    for (const p of siraya) {
      const isResin =
        p.product_type?.toLowerCase().includes("resin") ||
        p.tags.some((t) => t.toLowerCase().includes("resin")) ||
        p.title.toLowerCase().includes("resin");
      if (isResin) {
        items.push(...normaliseResin(p, "https://siraya.tech"));
      }
    }

    return items;
  });
}
