"use client";

import { useCallback, useEffect, useState } from "react";
import type { CatalogItem, CatalogItemType, CatalogBrand } from "@/types/catalog.types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { ColorSwatch } from "@/components/shared/color-swatch";
import { Loader2 } from "lucide-react";

interface CatalogBrowserProps {
  type: CatalogItemType;
  onSelect: (item: CatalogItem) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TYPE_LABELS: Record<CatalogItemType, string> = {
  filament: "Filaments",
  resin: "Resins",
  paint: "Paints",
};

const API_PATHS: Record<CatalogItemType, string> = {
  filament: "/api/catalog/filaments",
  resin: "/api/catalog/resins",
  paint: "/api/catalog/paints",
};

export function CatalogBrowser({
  type,
  onSelect,
  open,
  onOpenChange,
}: CatalogBrowserProps) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hasFetched, setHasFetched] = useState(false);

  // Fetch catalog data when dialog opens
  const fetchData = useCallback(
    async (brandFilter?: string, searchFilter?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (brandFilter) params.set("brand", brandFilter);
        if (searchFilter && searchFilter.length >= 2) params.set("search", searchFilter);

        const resp = await fetch(`${API_PATHS[type]}?${params.toString()}`);
        if (!resp.ok) throw new Error("Failed to fetch catalog");

        const data = await resp.json();
        setItems(data.items ?? []);
        if (data.brands) setBrands(data.brands);
      } catch (err) {
        console.error("Catalog fetch error:", err);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [type],
  );

  // Initial fetch when opening
  useEffect(() => {
    if (open && !hasFetched) {
      setHasFetched(true);
      fetchData();
    }
    if (!open) {
      setHasFetched(false);
      setActiveBrand(null);
      setSearch("");
    }
  }, [open, hasFetched, fetchData]);

  // Refetch when brand changes
  useEffect(() => {
    if (!open || !hasFetched) return;
    fetchData(activeBrand ?? undefined);
  }, [activeBrand, open, hasFetched, fetchData]);

  function handleSelect(item: CatalogItem) {
    onSelect(item);
    onOpenChange(false);
  }

  // Debounced search
  useEffect(() => {
    if (!open || !hasFetched) return;
    const timeout = setTimeout(() => {
      fetchData(activeBrand ?? undefined, search || undefined);
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  /** Secondary badge text based on item type */
  function getSubLabel(item: CatalogItem): string | null {
    if (item.type === "filament" && item.material) return item.material;
    if (item.type === "resin" && item.resinType) return item.resinType;
    if (item.type === "paint" && item.line) return item.line;
    return null;
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Browse ${TYPE_LABELS[type]} Catalog`}
      description={`Search and select a product to auto-fill the form`}
    >
      <CommandInput
        placeholder={`Search ${TYPE_LABELS[type].toLowerCase()}...`}
        value={search}
        onValueChange={setSearch}
      />

      {/* Brand filter chips */}
      {brands.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
          <Badge
            variant={activeBrand === null ? "default" : "outline"}
            className="cursor-pointer text-xs"
            onClick={() => setActiveBrand(null)}
          >
            All
          </Badge>
          {brands.map((b) => (
            <Badge
              key={b.id}
              variant={activeBrand === b.name ? "default" : "outline"}
              className="cursor-pointer text-xs"
              onClick={() =>
                setActiveBrand(activeBrand === b.name ? null : b.name)
              }
            >
              {b.name}
              <span className="ml-1 opacity-60">{b.itemCount}</span>
            </Badge>
          ))}
        </div>
      )}

      <CommandList className="max-h-[400px]">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading catalog...
          </div>
        )}

        {!loading && items.length === 0 && (
          <CommandEmpty>No products found.</CommandEmpty>
        )}

        {!loading && items.length > 0 && (
          <CommandGroup heading={`${items.length} product${items.length !== 1 ? "s" : ""}`}>
            {items.slice(0, 200).map((item) => {
              const sub = getSubLabel(item);
              return (
                <CommandItem
                  key={item.id}
                  value={`${item.name} ${item.brand} ${item.color ?? ""} ${sub ?? ""}`}
                  onSelect={() => handleSelect(item)}
                  className="flex items-center gap-3 py-2"
                >
                  {/* Colour swatch */}
                  {item.colorHex ? (
                    <ColorSwatch hex={item.colorHex} size="md" className="shrink-0" />
                  ) : (
                    <div className="h-6 w-6 shrink-0 rounded-sm border border-dashed border-border" />
                  )}

                  {/* Name + brand */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-sm">
                      {item.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.brand}
                      {item.color && item.color !== item.name
                        ? ` — ${item.color}`
                        : ""}
                    </span>
                  </div>

                  {/* Type / material badge */}
                  {sub && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {sub}
                    </Badge>
                  )}

                  {/* Finish badge for paints */}
                  {item.finish && item.finish !== "Matte" && (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {item.finish}
                    </Badge>
                  )}

                  {/* Price */}
                  {item.price != null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      ${item.price.toFixed(2)}
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
