"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { ColorSwatch } from "@/components/shared/color-swatch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CatalogItem, CatalogItemType } from "@/types/catalog.types";

const API_PATHS: Record<CatalogItemType, string> = {
  filament: "/api/catalog/filaments",
  resin: "/api/catalog/resins",
  paint: "/api/catalog/paints",
};

interface AutocompleteInputProps {
  /** Which catalog to search */
  type: CatalogItemType;
  /** Called when a suggestion is selected — use this to auto-fill the form */
  onSelectItem: (item: CatalogItem) => void;
  /** The current text value of the input */
  value: string;
  /** Standard onChange for the text input */
  onChange: (value: string) => void;
  /** Input placeholder */
  placeholder?: string;
  /** Additional className for the input */
  className?: string;
}

/**
 * A text input with catalog autocomplete suggestions.
 * When the user types ≥ 2 chars, it searches the catalog API and shows
 * a dropdown of matching products. Selecting one calls onSelectItem
 * to auto-fill the entire form.
 */
export function AutocompleteInput({
  type,
  onSelectItem,
  value,
  onChange,
  placeholder,
  className,
}: AutocompleteInputProps) {
  const [suggestions, setSuggestions] = useState<CatalogItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressRef = useRef(false);

  // Fetch suggestions when value changes (debounced)
  const fetchSuggestions = useCallback(
    async (query: string) => {
      if (query.length < 2) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }

      try {
        const params = new URLSearchParams({ search: query });
        const resp = await fetch(`${API_PATHS[type]}?${params.toString()}`);
        if (!resp.ok) return;

        const data = await resp.json();
        const items: CatalogItem[] = (data.items ?? []).slice(0, 8);
        setSuggestions(items);
        setIsOpen(items.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
        setIsOpen(false);
      }
    },
    [type],
  );

  useEffect(() => {
    // Don't fetch right after selecting an item
    if (suppressRef.current) {
      suppressRef.current = false;
      return;
    }

    const timeout = setTimeout(() => {
      fetchSuggestions(value);
    }, 300);
    return () => clearTimeout(timeout);
  }, [value, fetchSuggestions]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(item: CatalogItem) {
    suppressRef.current = true;
    onSelectItem(item);
    setIsOpen(false);
    setSuggestions([]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  }

  function getSubLabel(item: CatalogItem): string | null {
    if (item.type === "filament" && item.material) return item.material;
    if (item.type === "resin" && item.resinType) return item.resinType;
    if (item.type === "paint" && item.line) return item.line;
    return null;
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setIsOpen(true);
        }}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />

      {isOpen && suggestions.length > 0 && (
        <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-[240px] overflow-y-auto py-1">
            {suggestions.map((item, idx) => {
              const sub = getSubLabel(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                    idx === activeIndex && "bg-accent",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur before click
                    handleSelect(item);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  {item.colorHex ? (
                    <ColorSwatch hex={item.colorHex} size="sm" className="shrink-0" />
                  ) : (
                    <div className="h-4 w-4 shrink-0 rounded-sm border border-dashed border-border" />
                  )}

                  <span className="min-w-0 flex-1 truncate">{item.name}</span>

                  {sub && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] px-1 py-0">
                      {sub}
                    </Badge>
                  )}

                  {item.price != null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      ${item.price.toFixed(2)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
            Select to auto-fill form
          </div>
        </div>
      )}
    </div>
  );
}
