/**
 * Fetches miniature paint data from the Arcturus5404/miniature-paints GitHub repo
 * and converts Markdown tables into a single JSON file for the catalog API.
 *
 * Usage: npx tsx scripts/fetch-paint-data.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const GITHUB_RAW =
  "https://raw.githubusercontent.com/Arcturus5404/miniature-paints/main/paints";

// Brands to fetch — file names from the repo (without .md)
const BRANDS = [
  "AK",
  "Army_Painter",
  "Citadel_Colour",
  "CoatDArmes",
  "Foundry",
  "GreenStuffWorld",
  "Humbrol",
  "KimeraKolors",
  "Mig",
  "MissionModels",
  "Monument",
  "MrHobby",
  "P3",
  "Reaper",
  "Revell",
  "Scale75",
  "Tamiya",
  "TurboDork",
  "Vallejo",
  "Warcolours",
];

// Display names for brands (file name → human-friendly)
const BRAND_NAMES: Record<string, string> = {
  AK: "AK Interactive",
  Army_Painter: "The Army Painter",
  Citadel_Colour: "Citadel",
  CoatDArmes: "Coat d'Armes",
  Foundry: "Foundry",
  GreenStuffWorld: "Green Stuff World",
  Humbrol: "Humbrol",
  KimeraKolors: "Kimera Kolors",
  Mig: "AMMO by MIG",
  MissionModels: "Mission Models",
  Monument: "Monument Hobbies",
  MrHobby: "Mr. Hobby",
  P3: "P3 (Privateer Press)",
  Reaper: "Reaper",
  Revell: "Revell",
  Scale75: "Scale75",
  Tamiya: "Tamiya",
  TurboDork: "TurboDork",
  Vallejo: "Vallejo",
  Warcolours: "Warcolours",
};

// Map known range/set names to paint finish types
const FINISH_MAP: Record<string, string> = {
  // Citadel
  base: "Matte",
  layer: "Matte",
  air: "Matte",
  dry: "Matte",
  shade: "Wash",
  contrast: "Contrast",
  technical: "Other",
  "foundation (discontinued)": "Matte",
  "goblin green (discontinued)": "Matte",
  // Army Painter
  warpaints: "Matte",
  "warpaints fanatic": "Matte",
  "warpaints air": "Matte",
  speedpaint: "Contrast",
  "speedpaint set": "Contrast",
  "speedpaint set 2.0": "Contrast",
  "warpaints washes": "Wash",
  "warpaints effects": "Other",
  "warpaints metallics": "Metallic",
  "warpaints primer": "Primer",
  // Vallejo
  "model color": "Matte",
  "model air": "Matte",
  "game color": "Matte",
  "game air": "Matte",
  "game ink": "Ink",
  "game wash": "Wash",
  "metal color": "Metallic",
  "mecha color": "Matte",
  "mecha varnish": "Varnish",
  "surface primer": "Primer",
  "xpress color": "Contrast",
  panzer: "Matte",
  // Generic
  metallic: "Metallic",
  metallics: "Metallic",
  wash: "Wash",
  washes: "Wash",
  ink: "Ink",
  inks: "Ink",
  primer: "Primer",
  varnish: "Varnish",
};

interface PaintEntry {
  id: string;
  name: string;
  brand: string;
  type: "paint";
  color: string;
  colorHex: string;
  line: string;
  finish: string;
  productCode: string | null;
}

function extractHex(hexCell: string): string | null {
  // Format: ![#HEXHEX](url) `#HEXHEX` — extract from backtick code
  const backtickMatch = hexCell.match(/`(#[0-9A-Fa-f]{6})`/);
  if (backtickMatch) return backtickMatch[1];

  // Fallback: raw hex
  const rawMatch = hexCell.match(/#[0-9A-Fa-f]{6}/);
  if (rawMatch) return rawMatch[0];

  return null;
}

function guessFinish(setName: string): string {
  const lower = setName.toLowerCase().trim();

  // Direct match
  if (FINISH_MAP[lower]) return FINISH_MAP[lower];

  // Partial match
  for (const [key, value] of Object.entries(FINISH_MAP)) {
    if (lower.includes(key)) return value;
  }

  return "Matte"; // Default
}

function parseMarkdownTable(markdown: string, brandFile: string): PaintEntry[] {
  const brandName = BRAND_NAMES[brandFile] || brandFile.replace(/_/g, " ");
  const lines = markdown.split("\n").filter((l) => l.trim().startsWith("|"));

  if (lines.length < 2) return [];

  // Parse header to determine column layout
  const header = lines[0]
    .split("|")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const hasCode = header.includes("code");

  // Determine column indices
  const nameIdx = 0;
  const codeIdx = hasCode ? 1 : -1;
  const setIdx = hasCode ? 2 : 1;
  // RGB column indices (3-5 or 2-4) skipped — we use hex directly
  const hexIdx = hasCode ? 6 : 5;

  const entries: PaintEntry[] = [];

  // Skip header and separator rows
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i]
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    if (cells.length < (hasCode ? 7 : 6)) continue;

    const name = cells[nameIdx];
    const code = codeIdx >= 0 ? cells[codeIdx] : null;
    const set = cells[setIdx] || "";
    const hex = extractHex(cells[hexIdx]);

    if (!name || !hex) continue;

    const finish = guessFinish(set);
    const id = `paint-${brandFile}-${name}-${set}`.replace(/[^a-zA-Z0-9-]/g, "_").toLowerCase();

    entries.push({
      id,
      name,
      brand: brandName,
      type: "paint",
      color: name, // For paints, the name IS the color
      colorHex: hex,
      line: set,
      finish,
      productCode: code && code !== "null" ? code : null,
    });
  }

  return entries;
}

async function fetchBrand(brandFile: string): Promise<PaintEntry[]> {
  const url = `${GITHUB_RAW}/${brandFile}.md`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`  ⚠ Failed to fetch ${brandFile}: ${resp.status}`);
      return [];
    }
    const md = await resp.text();
    const entries = parseMarkdownTable(md, brandFile);
    console.log(`  ✓ ${BRAND_NAMES[brandFile] || brandFile}: ${entries.length} paints`);
    return entries;
  } catch (err) {
    console.warn(`  ⚠ Error fetching ${brandFile}:`, err);
    return [];
  }
}

async function main() {
  console.log("Fetching paint data from GitHub...\n");

  const allEntries: PaintEntry[] = [];

  // Fetch in batches of 5 to avoid rate limits
  for (let i = 0; i < BRANDS.length; i += 5) {
    const batch = BRANDS.slice(i, i + 5);
    const results = await Promise.all(batch.map(fetchBrand));
    allEntries.push(...results.flat());
  }

  console.log(`\nTotal: ${allEntries.length} paints from ${BRANDS.length} brands`);

  // Write JSON
  const outDir = resolve(__dirname, "../src/data/catalog");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "paints.json");
  writeFileSync(outPath, JSON.stringify(allEntries, null, 2));
  console.log(`\nWritten to: ${outPath}`);
}

main().catch(console.error);
