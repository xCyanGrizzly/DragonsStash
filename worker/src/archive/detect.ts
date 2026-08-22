export type ArchiveFormat = "ZIP" | "RAR" | "7Z" | "DOCUMENT";

export interface MultipartInfo {
  baseName: string;
  partNumber: number;
  format: ArchiveFormat;
  pattern: "ARCHIVE_NUMBERED" | "ZIP_LEGACY" | "RAR_PART" | "RAR_LEGACY" | "SINGLE";
}

const patterns: {
  regex: RegExp;
  /** A fixed format, or one derived from the match for patterns spanning several formats. */
  format: ArchiveFormat | ((match: RegExpMatchArray) => ArchiveFormat);
  pattern: MultipartInfo["pattern"];
  getBaseName: (match: RegExpMatchArray) => string;
  getPartNumber: (match: RegExpMatchArray) => number;
}[] = [
  // pack.zip.001, pack.rar.001, pack.7z.001 (numbered volume split — one pattern for
  // every format, so a new format can never be silently dropped for lack of its own entry).
  // {2,} digits also picks up hand-renamed sets like pack.rar.01.
  {
    regex: /^(.+\.(zip|7z|rar))\.(\d{2,})$/i,
    // The regex only ever captures zip/7z/rar, so uppercasing yields a valid ArchiveFormat.
    format: (m) => m[2].toUpperCase() as ArchiveFormat,
    pattern: "ARCHIVE_NUMBERED",
    getBaseName: (m) => m[1], // includes the archive extension
    getPartNumber: (m) => parseInt(m[3], 10),
  },
  // pack.z01, pack.z02 (legacy split — pack.zip is the FINAL disk of the set)
  {
    regex: /^(.+)\.z(\d{2,})$/i,
    format: "ZIP",
    pattern: "ZIP_LEGACY",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
  // pack.part1.rar, pack.part2.rar — .exe covers a self-extracting first volume
  // (pack.part1.exe + pack.part2.rar + ...), which is still a RAR volume set.
  {
    regex: /^(.+)\.part(\d+)\.(rar|exe)$/i,
    format: "RAR",
    pattern: "RAR_PART",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
  // pack.r00, pack.r01 (legacy split — pack.rar is the FIRST volume, .r00 onwards follow it)
  {
    regex: /^(.+)\.r(\d{2,})$/i,
    format: "RAR",
    pattern: "RAR_LEGACY",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
];

/** Extensions we recognize as fetchable documents (archives + standalone files).
 *  Deliberately excludes image formats — previews posted as uncompressed documents
 *  must go through the photo-matching path, not become packages of their own. */
const DOCUMENT_EXTENSIONS =
  /\.(pdf|stl|obj|3mf|step|stp|blend1|blend|gcode|svg|dxf|ai|eps|psd|lys|lyt|lymesh|chitubox|ctp|ctb|cbddlp|photon|pwmx|pwmo|pws|sl1|goo|phz|pm3|fbx|ply|glb|gltf|3ds|max|c4d|ztl|zpr|mtl|f3d|scad|igs|iges|sldprt|form|skp|wrl)$/i;

/**
 * Detect if a filename is an archive and extract multipart info.
 */
export function detectArchive(fileName: string): MultipartInfo | null {
  // TDLib hands us `document.file_name` verbatim and every pattern below is `$`-anchored,
  // so "Pack.zip " or "Pack.zip." would otherwise be dropped without a trace. Trailing dots
  // are stripped too: no filesystem or archiver can produce a meaningful one (Windows
  // silently drops them), so a trailing dot is always cosmetic damage from a re-upload,
  // never part of the real name. The normalized value is used for matching AND baseName.
  const name = fileName.trim().replace(/[.\s]+$/, "");
  if (!name) return null;

  // Check multipart patterns first
  for (const p of patterns) {
    const match = name.match(p.regex);
    if (match) {
      return {
        baseName: p.getBaseName(match),
        partNumber: p.getPartNumber(match),
        format: typeof p.format === "function" ? p.format(match) : p.format,
        pattern: p.pattern,
      };
    }
  }

  // Single .zip file — could be a standalone or the final part of a ZIP_LEGACY set
  if (/\.zip$/i.test(name)) {
    return {
      baseName: name.replace(/\.zip$/i, ""),
      partNumber: -1, // -1 signals "could be single or final legacy part"
      format: "ZIP",
      pattern: "SINGLE",
    };
  }

  // Single .rar file — could be standalone or the FIRST part of a RAR_LEGACY set
  if (/\.rar$/i.test(name)) {
    return {
      baseName: name.replace(/\.rar$/i, ""),
      partNumber: -1,
      format: "RAR",
      pattern: "SINGLE",
    };
  }

  // Single .7z file
  if (/\.7z$/i.test(name)) {
    return {
      baseName: name.replace(/\.7z$/i, ""),
      partNumber: -1,
      format: "7Z",
      pattern: "SINGLE",
    };
  }

  // Standalone documents (PDFs, STLs, 3D files, slicer projects, etc.)
  if (DOCUMENT_EXTENSIONS.test(name)) {
    return {
      baseName: name.replace(DOCUMENT_EXTENSIONS, ""),
      partNumber: -1,
      format: "DOCUMENT",
      pattern: "SINGLE",
    };
  }

  return null;
}

/**
 * Check if a filename looks like any attachment we should process.
 */
export function isArchiveAttachment(fileName: string): boolean {
  return detectArchive(fileName) !== null;
}
