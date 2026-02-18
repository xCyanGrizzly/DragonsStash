/**
 * Simple in-memory cache with TTL.
 * Used to avoid hammering external Shopify APIs on every request.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour

export async function cachedFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL,
): Promise<T> {
  const existing = store.get(key) as CacheEntry<T> | undefined;

  if (existing && existing.expiresAt > Date.now()) {
    return existing.data;
  }

  const data = await fetchFn();
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

/** Clear a specific cache key or the entire cache. */
export function clearCache(key?: string) {
  if (key) {
    store.delete(key);
  } else {
    store.clear();
  }
}

/**
 * Deduplicate catalog items that share the same product+color but differ
 * only in size/weight. Keeps the smallest (cheapest) variant of each group.
 */
export function deduplicateItems<
  T extends { brand: string; name: string; color?: string; price?: number; weight?: number; volume?: number },
>(items: T[]): T[] {
  const groups = new Map<string, T>();

  for (const item of items) {
    // Key on brand + display name (already includes color via "Product — Color")
    const key = `${item.brand}|${item.name}`.toLowerCase();
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, item);
      continue;
    }

    // Prefer the entry with the lower price (typically the smaller size)
    if (item.price != null && existing.price != null && item.price < existing.price) {
      groups.set(key, item);
    }
  }

  return Array.from(groups.values());
}
