/**
 * Extract a creator name from common archive file naming patterns.
 *
 * Priority in the worker: topic name > filename extraction.
 * This is the fallback when no forum topic name is available.
 *
 * Patterns handled (split on ` - `):
 *   "Mammoth Factory - 2026-01.zip"        → "Mammoth Factory"
 *   "Artist Name - Pack Title.part01.rar"   → "Artist Name"
 *   "some_random_file.zip"                  → null
 */
export function extractCreatorFromFileName(fileName: string): string | null {
  // Strip archive extensions (.zip, .rar, .part01.rar, .z01, etc.)
  const bare = fileName.replace(/(\.(part\d+\.rar|z\d{2}|zip|rar))+$/i, "");

  const idx = bare.indexOf(" - ");
  if (idx <= 0) return null;

  const creator = bare.slice(0, idx).trim();
  return creator.length > 0 ? creator : null;
}
