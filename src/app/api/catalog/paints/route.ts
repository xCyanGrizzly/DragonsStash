import { NextRequest, NextResponse } from "next/server";
import type { CatalogBrand, CatalogItem, CatalogResponse } from "@/types/catalog.types";

// Static import — bundled at build time from the generated JSON
import paintsData from "@/data/catalog/paints.json";

const allPaints = paintsData as CatalogItem[];

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const brandFilter = searchParams.get("brand")?.toLowerCase();
  const search = searchParams.get("search")?.toLowerCase();

  let items = allPaints;

  if (brandFilter) {
    items = items.filter((p) => p.brand.toLowerCase() === brandFilter);
  }

  if (search) {
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.brand.toLowerCase().includes(search) ||
        (p.line && p.line.toLowerCase().includes(search)) ||
        (p.productCode && p.productCode.toLowerCase().includes(search)),
    );
  }

  // Build brand summary from the FULL dataset (not filtered)
  const brandMap = new Map<string, number>();
  for (const p of allPaints) {
    brandMap.set(p.brand, (brandMap.get(p.brand) ?? 0) + 1);
  }

  const brands: CatalogBrand[] = Array.from(brandMap.entries())
    .map(([name, count]) => ({
      id: name.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      name,
      type: "paint" as const,
      itemCount: count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const response: CatalogResponse = { items, brands };
  return NextResponse.json(response);
}
