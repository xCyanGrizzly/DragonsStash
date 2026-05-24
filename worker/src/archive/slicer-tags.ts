import type { FileEntry } from "./zip-reader.js";

/**
 * Mapping from file extensions to slicer tags. Each tag groups a family of
 * extensions that mean the same thing for end users — "this archive contains
 * files I can open in <slicer>".
 *
 * Extensions are matched case-insensitively without the leading dot.
 */
const SLICER_EXTENSION_MAP: Record<string, string> = {
  // Lychee Slicer
  lys: "lychee",
  lyt: "lychee",
  lyc: "lychee",

  // ChituBox / Anycubic / Phrozen / Elegoo (resin printers)
  chitubox: "chitubox",
  ctb: "chitubox",
  cbddlp: "chitubox",

  // Anycubic Photon family
  photon: "anycubic",
  pwmo: "anycubic",
  pwmx: "anycubic",
  pwmb: "anycubic",
  pwma: "anycubic",
  pws: "anycubic",
  pwsq: "anycubic",
  phz: "anycubic",

  // Bambu / Prusa
  "3mf": "bambu",
  bgcode: "bambu",

  // FDM gcode (generic)
  gcode: "fdm",

  // Mango / generic resin formats sometimes seen in releases
  mfp: "mango",
  mfpv: "mango",
  osla: "mango",
};

/**
 * Derive a deduplicated list of slicer tags from an archive's file listing.
 * Returns an empty array if no recognised slicer-specific files are present
 * (e.g., the archive is just STLs without pre-supports).
 */
export function extractSlicerTags(entries: FileEntry[]): string[] {
  const tags = new Set<string>();
  for (const entry of entries) {
    if (!entry.extension) continue;
    const ext = entry.extension.toLowerCase();
    const tag = SLICER_EXTENSION_MAP[ext];
    if (tag) tags.add(tag);
  }
  return [...tags].sort();
}
