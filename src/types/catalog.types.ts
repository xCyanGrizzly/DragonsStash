export type CatalogItemType = "filament" | "resin" | "paint";

export interface CatalogItem {
  id: string;
  name: string;
  brand: string;
  type: CatalogItemType;
  color?: string;
  colorHex?: string;
  material?: string;
  resinType?: string;
  line?: string;
  finish?: string;
  volume?: number;
  weight?: number;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productCode?: string;
  sourceUrl?: string;
}

export interface CatalogBrand {
  id: string;
  name: string;
  type: CatalogItemType;
  itemCount: number;
}

export interface CatalogResponse {
  items: CatalogItem[];
  brands: CatalogBrand[];
}
