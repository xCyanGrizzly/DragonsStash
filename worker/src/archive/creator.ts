/**
 * Extract a creator name from common archive file naming patterns.
 *
 * Priority in the worker: topic name > filename extraction > channel title > null.
 *
 * Patterns handled:
 *   "Mammoth Factory - 2026-01.zip"        → "Mammoth Factory"
 *   "Artist Name - Pack Title.part01.rar"   → "Artist Name"
 *   "ArtistName_PackTitle.zip"              → null (ambiguous)
 *   "some_random_file.zip"                  → null
 */
export function extractCreatorFromFileName(fileName: string): string | null {
  // Strip archive/document extensions
  const bare = fileName.replace(
    /(\.(part\d+\.rar|z\d{2}|zip|rar|7z|pdf|stl|obj|3mf|step|stp|blend|gcode|svg|dxf|ai|eps|psd))+$/i,
    ""
  );

  // Pattern 1: "Creator - Title" (most common)
  const dashIdx = bare.indexOf(" - ");
  if (dashIdx > 0) {
    const creator = bare.slice(0, dashIdx).trim();
    if (creator.length > 1) return creator;
  }

  // Pattern 2: "Creator_Title" with underscores where first segment looks like a name
  // Only match if the first segment has a space or capital letter pattern suggesting a name
  const underscoreIdx = bare.indexOf("_");
  if (underscoreIdx > 2) {
    const candidate = bare.slice(0, underscoreIdx).trim();
    // Accept if it contains a space (multi-word) or starts with upper + has lower (proper name)
    if (candidate.includes(" ") || /^[A-Z][a-z]/.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Extract a creator name from a Telegram channel title.
 * Strips common suffixes like "[Completed]", "(Paid)", dates, etc.
 */
export function extractCreatorFromChannelTitle(title: string): string | null {
  let clean = title
    // Remove bracketed suffixes: [Completed], [Open], [Closed], etc.
    .replace(/\s*\[.*?\]\s*/g, " ")
    // Remove parenthesized suffixes: (Paid), (partial upload...), etc.
    .replace(/\s*\(.*?\)\s*/g, " ")
    // Remove common emoji
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .trim();

  // If there's a " - " separator, take the first part as creator
  const dashIdx = clean.indexOf(" - ");
  if (dashIdx > 0) {
    clean = clean.slice(0, dashIdx).trim();
  }

  // Too generic or too short
  if (clean.length < 2) return null;

  // Skip overly generic channel names
  const generic = [
    "3d printing", "stl", "free stl", "stl zone", "stl forest", "stl all",
    "marvel stl", "dc stl", "star wars stl", "pokemon stl",
  ];
  if (generic.includes(clean.toLowerCase())) return null;

  return clean;
}
