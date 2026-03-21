export type ArchiveFormat = "ZIP" | "RAR" | "7Z" | "DOCUMENT";

export interface MultipartInfo {
  baseName: string;
  partNumber: number;
  format: ArchiveFormat;
  pattern: "ZIP_NUMBERED" | "ZIP_LEGACY" | "RAR_PART" | "RAR_LEGACY" | "SINGLE";
}

const patterns: {
  regex: RegExp;
  format: ArchiveFormat;
  pattern: MultipartInfo["pattern"];
  getBaseName: (match: RegExpMatchArray) => string;
  getPartNumber: (match: RegExpMatchArray) => number;
}[] = [
  // pack.zip.001, pack.zip.002
  {
    regex: /^(.+\.zip)\.(\d{3,})$/i,
    format: "ZIP",
    pattern: "ZIP_NUMBERED",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
  // pack.z01, pack.z02 (legacy split — final part is pack.zip)
  {
    regex: /^(.+)\.z(\d{2,})$/i,
    format: "ZIP",
    pattern: "ZIP_LEGACY",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
  // pack.part1.rar, pack.part2.rar
  {
    regex: /^(.+)\.part(\d+)\.rar$/i,
    format: "RAR",
    pattern: "RAR_PART",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
  // pack.r00, pack.r01 (legacy split — final part is pack.rar)
  {
    regex: /^(.+)\.r(\d{2,})$/i,
    format: "RAR",
    pattern: "RAR_LEGACY",
    getBaseName: (m) => m[1],
    getPartNumber: (m) => parseInt(m[2], 10),
  },
];

/** Extensions we recognize as fetchable documents (archives + standalone files) */
const DOCUMENT_EXTENSIONS = /\.(pdf|stl|obj|3mf|step|stp|blend|gcode|svg|dxf|ai|eps|psd)$/i;

/**
 * Detect if a filename is an archive and extract multipart info.
 */
export function detectArchive(fileName: string): MultipartInfo | null {
  // Check multipart patterns first
  for (const p of patterns) {
    const match = fileName.match(p.regex);
    if (match) {
      return {
        baseName: p.getBaseName(match),
        partNumber: p.getPartNumber(match),
        format: p.format,
        pattern: p.pattern,
      };
    }
  }

  // Single .zip file — could be a standalone or the final part of a ZIP_LEGACY set
  if (/\.zip$/i.test(fileName)) {
    return {
      baseName: fileName.replace(/\.zip$/i, ""),
      partNumber: -1, // -1 signals "could be single or final legacy part"
      format: "ZIP",
      pattern: "SINGLE",
    };
  }

  // Single .rar file — could be standalone or final part of RAR_LEGACY set
  if (/\.rar$/i.test(fileName)) {
    return {
      baseName: fileName.replace(/\.rar$/i, ""),
      partNumber: -1,
      format: "RAR",
      pattern: "SINGLE",
    };
  }

  // Single .7z file
  if (/\.7z$/i.test(fileName)) {
    return {
      baseName: fileName.replace(/\.7z$/i, ""),
      partNumber: -1,
      format: "7Z",
      pattern: "SINGLE",
    };
  }

  // Standalone documents (PDFs, STLs, 3D files, etc.)
  if (DOCUMENT_EXTENSIONS.test(fileName)) {
    const ext = fileName.match(DOCUMENT_EXTENSIONS)![0];
    return {
      baseName: fileName.replace(DOCUMENT_EXTENSIONS, ""),
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
