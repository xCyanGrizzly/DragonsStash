"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CatalogBrowser } from "@/components/shared/catalog-browser";
import type { CatalogItem, CatalogItemType } from "@/types/catalog.types";

interface CatalogBrowserButtonProps {
  type: CatalogItemType;
  onSelect: (item: CatalogItem) => void;
}

export function CatalogBrowserButton({ type, onSelect }: CatalogBrowserButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Search className="mr-2 h-4 w-4" />
        Browse Catalog
      </Button>

      <CatalogBrowser
        type={type}
        open={open}
        onOpenChange={setOpen}
        onSelect={onSelect}
      />
    </>
  );
}
