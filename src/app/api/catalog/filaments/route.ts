import { NextRequest, NextResponse } from "next/server";
import type { CatalogBrand, CatalogResponse } from "@/types/catalog.types";
import { fetchFilaments } from "@/lib/catalog/shopify";
import { deduplicateItems } from "@/lib/catalog/cache";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const brandFilter = searchParams.get("brand")?.toLowerCase();
  const search = searchParams.get("search")?.toLowerCase();

  try {
    let items = deduplicateItems(await fetchFilaments());

    // Build brand summary from unfiltered data
    const brandMap = new Map<string, number>();
    for (const p of items) {
      brandMap.set(p.brand, (brandMap.get(p.brand) ?? 0) + 1);
    }

    if (brandFilter) {
      items = items.filter((p) => p.brand.toLowerCase() === brandFilter);
    }

    if (search) {
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(search) ||
          p.brand.toLowerCase().includes(search) ||
          (p.color && p.color.toLowerCase().includes(search)) ||
          (p.material && p.material.toLowerCase().includes(search)),
      );
    }

    const brands: CatalogBrand[] = Array.from(brandMap.entries())
      .map(([name, count]) => ({
        id: name.toLowerCase().replace(/[^a-z0-9]/g, "_"),
        name,
        type: "filament" as const,
        itemCount: count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const response: CatalogResponse = { items, brands };
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to fetch filament catalog:", error);
    return NextResponse.json(
      { items: [], brands: [], error: "Failed to fetch filament data" },
      { status: 500 },
    );
  }
}
