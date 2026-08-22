import { crc32 } from "zlib"; // Node 20+ exposes zlib.crc32

/**
 * Test-only builders that emit real ZIP byte streams.
 *
 * Two distinct on-disk shapes are produced here, because the worker has to
 * tell them apart:
 *
 *  - `buildSpannedStoreZip` → a ZIP-spec **spanned/multi-disk** archive
 *    (`Pack.z01`, `Pack.z02`, …, `Pack.zip`). Each volume is its own file;
 *    central-directory records carry a disk number, and the EOCD's
 *    "offset of start of central directory" is relative to the *start of the
 *    disk that holds it*, not to a concatenation of the volumes.
 *
 *  - `buildStoreZip` → an ordinary single-file ZIP. Cutting its bytes into
 *    chunks yields the 7-Zip raw byte split shape (`Pack.zip.001`, …), where
 *    all disk numbers are 0 and offsets are whole-archive absolute.
 *
 * Field layouts follow APPNOTE 6.3.x sections 4.3.12 (central directory) and
 * 4.3.16 (EOCD). Verified against Info-ZIP `zip -s` output.
 */

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** APPNOTE 8.5.3: the first volume of a spanned archive starts with this. */
const SPANNING_SIG = 0x08074b50;

export interface FixtureFile {
  name: string;
  data: Buffer;
  /** 0-based volume this file's local header + data is written to. */
  disk?: number;
}

function localHeader(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method = store
  local.writeUInt32LE(crc32(data) >>> 0, 14);
  local.writeUInt32LE(data.length, 18); // compressed
  local.writeUInt32LE(data.length, 22); // uncompressed
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  return Buffer.concat([local, nameBuf, data]);
}

function centralHeader(name: string, data: Buffer, diskStart: number, relOffset: number): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(CD_SIG, 0);
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8); // flags
  cd.writeUInt16LE(0, 10); // method = store
  cd.writeUInt32LE(crc32(data) >>> 0, 16);
  cd.writeUInt32LE(data.length, 20); // compressed
  cd.writeUInt32LE(data.length, 24); // uncompressed
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(diskStart, 34); // disk number start
  cd.writeUInt32LE(relOffset, 42); // offset of local header, relative to its disk
  return Buffer.concat([cd, nameBuf]);
}

function eocd(opts: {
  thisDisk: number;
  cdStartDisk: number;
  entriesThisDisk: number;
  entriesTotal: number;
  cdSize: number;
  cdOffset: number;
}): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(EOCD_SIG, 0);
  buf.writeUInt16LE(opts.thisDisk, 4);
  buf.writeUInt16LE(opts.cdStartDisk, 6);
  buf.writeUInt16LE(opts.entriesThisDisk, 8);
  buf.writeUInt16LE(opts.entriesTotal, 10);
  buf.writeUInt32LE(opts.cdSize, 12);
  buf.writeUInt32LE(opts.cdOffset, 16);
  return buf;
}

/** Build an ordinary single-file STORE ZIP (all disk numbers 0). */
export function buildStoreZip(files: FixtureFile[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const local = localHeader(f.name, f.data);
    body.push(local);
    central.push(centralHeader(f.name, f.data, 0, offset));
    offset += local.length;
  }
  const cdBuf = Buffer.concat(central);
  return Buffer.concat([
    ...body,
    cdBuf,
    eocd({
      thisDisk: 0,
      cdStartDisk: 0,
      entriesThisDisk: files.length,
      entriesTotal: files.length,
      cdSize: cdBuf.length,
      cdOffset: offset,
    }),
  ]);
}

/**
 * Build a ZIP-spec spanned archive as one Buffer per volume.
 * Returned array is volume order: [z01, z02, …, zip] (last element is the
 * final volume, which carries the central directory and EOCD).
 *
 * `cdStartDisk` (default: last volume) lets a test place the central
 * directory so that it begins on an earlier volume and spills forward,
 * exercising the cross-volume read path. As in a real writer, no file data
 * may live on a volume after the one the directory starts on — those volumes
 * hold directory continuation only.
 */
export function buildSpannedStoreZip(
  files: FixtureFile[],
  totalDisks: number,
  opts: { cdStartDisk?: number } = {}
): Buffer[] {
  const cdStart = opts.cdStartDisk ?? totalDisks - 1;
  for (const f of files) {
    if ((f.disk ?? 0) > cdStart) {
      throw new Error(`fixture misuse: ${f.name} is on volume ${f.disk} but the CD starts on ${cdStart}`);
    }
    if ((f.disk ?? 0) >= totalDisks) {
      throw new Error(`fixture misuse: ${f.name} is on volume ${f.disk} of ${totalDisks}`);
    }
  }
  const chunks: Buffer[][] = Array.from({ length: totalDisks }, () => []);
  const lengths = new Array<number>(totalDisks).fill(0);

  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(SPANNING_SIG, 0);
  chunks[0].push(marker);
  lengths[0] = 4;

  const central: Buffer[] = [];
  for (const f of files) {
    const disk = f.disk ?? 0;
    const local = localHeader(f.name, f.data);
    central.push(centralHeader(f.name, f.data, disk, lengths[disk]));
    chunks[disk].push(local);
    lengths[disk] += local.length;
  }

  const cdBuf = Buffer.concat(central);
  const lastDisk = totalDisks - 1;
  const cdStartDisk = cdStart;
  const cdOffset = lengths[cdStartDisk];

  // Write the CD starting on cdStartDisk, spilling onto later volumes.
  const spillDisks = lastDisk - cdStartDisk + 1;
  const firstChunkLen = Math.ceil(cdBuf.length / spillDisks);
  let written = 0;
  for (let d = cdStartDisk; d <= lastDisk; d++) {
    const take = d === lastDisk ? cdBuf.length - written : Math.min(firstChunkLen, cdBuf.length - written);
    chunks[d].push(cdBuf.subarray(written, written + take));
    lengths[d] += take;
    written += take;
  }

  chunks[lastDisk].push(
    eocd({
      thisDisk: lastDisk,
      cdStartDisk,
      entriesThisDisk: files.length,
      entriesTotal: files.length,
      cdSize: cdBuf.length,
      cdOffset,
    })
  );

  return chunks.map((c) => Buffer.concat(c));
}

/** Cut a buffer into `count` roughly equal chunks (7-Zip raw byte split). */
export function byteSplit(buf: Buffer, count: number): Buffer[] {
  const size = Math.ceil(buf.length / count);
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}
