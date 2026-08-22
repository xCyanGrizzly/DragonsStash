import path from "path";
import type { Client } from "tdl";
import { mkdir, rm } from "fs/promises";
import type { Prisma } from "@prisma/client";
import { db } from "./db/client.js";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { downloadFile, invokeWithTimeout } from "./tdlib/download.js";
import { scanChatDocuments, type ChatDocument } from "./tdlib/chat-documents.js";
import { getActiveAccounts } from "./db/queries.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
import { extractSlicerTags } from "./archive/slicer-tags.js";
import { readScannedListingRanged } from "./archive/ranged/dispatch.js";
import type { RangedPart } from "./archive/ranged/sevenz-ranged.js";
import { planListingRead, planRangedFallback } from "./archive/listing-plan.js";
import { buildDestIndex, resolveDestPartSet, type DestIndex } from "./dest-index.js";
import { parseBackfillPayload, type BackfillPlan } from "./backfill-scope.js";
import type { FileEntry } from "./archive/zip-reader.js";

const log = childLogger("backfill");

/**
 * Re-extract file listings for Packages whose fileCount is 0 — historically a
 * reader bug (the RAR parser that silently returned [] before 0bdd4ba; the
 * spanned-ZIP offset bug before 402c317) rather than a genuinely empty archive.
 *
 * Two things dominate the cost of doing this, and both are handled here:
 *
 *  1. **Reading the listing.** A file list lives in a few tens of kilobytes of
 *     an archive's header or tail. `readScannedListingRanged` fetches exactly
 *     those bytes, so a 35GB spanned set costs ~64KB instead of 35GB. The
 *     full-download path remains as a fallback for archives ranged reading
 *     genuinely cannot handle — and `rangedOnly` turns it off when the
 *     difference would be terabytes.
 *
 *  2. **Knowing which messages the archive's parts are.** A Package whose
 *     `destMessageIds` array is empty falls back to `[destMessageId]`, which is
 *     the *first* uploaded part. A lone `.z01` has no central directory at all,
 *     so that package can never be listed. With `recoverDestIds` the batch pays
 *     for one destination-channel scan and recovers the complete, ordered part
 *     set for every candidate at once — then persists it, so the package stays
 *     repairable.
 *
 * Triggered via pg_notify "backfill_filelists"; see `backfill-scope.ts` for the
 * payload contract. A payload with no narrowing selector is rejected — the
 * unscoped sweep has to ask for itself.
 */
export async function processBackfillRequest(payloadJson: string): Promise<void> {
  const parsed = parseBackfillPayload(payloadJson);
  if (!parsed.ok) {
    log.warn({ payload: payloadJson, error: parsed.error }, "Backfill request rejected — nothing was read or written");
    return;
  }
  const plan = parsed.plan;

  const candidates = await findBackfillCandidates(plan);
  if (candidates.length === 0) {
    log.info({ scope: plan.describe }, "Backfill: no candidates with fileCount=0");
    return;
  }

  const totalBytes = candidates.reduce((sum, c) => sum + c.fileSize, 0n);
  log.info(
    { count: candidates.length, scope: plan.describe, totalBytes: totalBytes.toString() },
    "Backfill: starting batch"
  );

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    log.warn("Backfill: no authenticated accounts — aborting");
    return;
  }

  // Prefer the Premium account if available (faster downloads, larger files)
  const account = accounts.find((a) => a.isPremium) ?? accounts[0];

  await withTdlibMutex(account.phone, "backfill", async () => {
    const { client } = await createTdlibClient({ id: account.id, phone: account.phone });

    try {
      // Load chats so TDLib knows about the destination chat
      try {
        await client.invoke({
          _: "getChats",
          chat_list: { _: "chatListMain" },
          limit: 1000,
        });
      } catch {
        // May already be loaded
      }

      const destIndexes = await buildDestIndexes(client, plan, candidates);

      const counters: BackfillCounters = {
        processed: 0,
        listedRanged: 0,
        listedDownload: 0,
        skipped: 0,
        failed: 0,
        idsRecovered: 0,
        concatUnlistable: 0,
      };

      for (const pkg of candidates) {
        counters.processed++;
        const ctx = { packageId: pkg.id, fileName: pkg.fileName };

        try {
          await repairOnePackage(client, pkg, ctx, plan, destIndexes, counters);
        } catch (err) {
          counters.failed++;
          log.warn({ err, ...ctx }, "Backfill failed for package");
        }
      }

      log.info({ ...counters, scope: plan.describe }, "Backfill batch complete");
    } finally {
      await closeTdlibClient(client).catch(() => {});
    }
  });
}

interface BackfillCounters {
  processed: number;
  listedRanged: number;
  listedDownload: number;
  skipped: number;
  failed: number;
  idsRecovered: number;
  concatUnlistable: number;
}

interface BackfillPackage {
  id: string;
  fileName: string;
  fileSize: bigint;
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT" | string;
  destChannelId: string | null;
  destMessageId: bigint | null;
  destMessageIds: bigint[];
  isMultipart: boolean;
  partCount: number;
}

/** Build the `where` clause from a validated plan. */
export function backfillCandidateWhere(plan: BackfillPlan): Prisma.PackageWhereInput {
  const { selector } = plan;
  return {
    fileCount: 0,
    destChannelId: { not: null },
    destMessageId: { not: null },
    archiveType: selector.archiveType ?? { in: ["ZIP", "RAR", "SEVEN_Z"] },
    ...(selector.packageIds ? { id: { in: selector.packageIds } } : {}),
    ...(selector.fileName ? { fileName: selector.fileName } : {}),
  };
}

async function findBackfillCandidates(plan: BackfillPlan): Promise<BackfillPackage[]> {
  return db.package.findMany({
    where: backfillCandidateWhere(plan),
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      archiveType: true,
      destChannelId: true,
      destMessageId: true,
      destMessageIds: true,
      isMultipart: true,
      partCount: true,
    },
    orderBy: { createdAt: "asc" },
    take: plan.limit,
  });
}

/**
 * Scan each destination channel that has candidates needing id recovery, once.
 *
 * The scan is the expensive part of a repair run (a few hundred paginated
 * `searchChatMessages` calls on a large channel), so it is opt-in via
 * `recoverDestIds` and it is amortised across the whole batch. Its by-product —
 * a fileId and size for every destination document — also removes the need for
 * a per-part `getMessage` on every candidate, recovered or not.
 */
async function buildDestIndexes(
  client: Client,
  plan: BackfillPlan,
  candidates: BackfillPackage[]
): Promise<Map<string, DestIndex>> {
  const indexes = new Map<string, DestIndex>();
  if (!plan.recoverDestIds) return indexes;

  const channelIds = new Set<string>();
  for (const pkg of candidates) {
    if (pkg.destChannelId && pkg.destMessageIds.length === 0) channelIds.add(pkg.destChannelId);
  }
  if (channelIds.size === 0) {
    log.info("Backfill: every candidate already has destMessageIds — skipping the destination scan");
    return indexes;
  }

  for (const channelId of channelIds) {
    const channel = await db.telegramChannel.findUnique({
      where: { id: channelId },
      select: { telegramId: true, title: true },
    });
    if (!channel) {
      log.warn({ channelId }, "Backfill: destination channel not found in DB — cannot recover ids for it");
      continue;
    }
    log.info({ channelId, title: channel.title }, "Backfill: scanning destination channel to recover destMessageIds");
    const scan = await scanChatDocuments(client, channel.telegramId);
    if (scan.truncated) {
      log.warn(
        { channelId, pages: scan.pages },
        "Backfill: destination scan hit the page limit — recovery may be incomplete for older packages"
      );
    }
    indexes.set(channelId, buildDestIndex(scan.documents));
  }
  return indexes;
}

/** Resolved destination parts plus how they were obtained. */
interface ResolvedDestParts {
  parts: RangedPart[];
  /** Message ids in upload order, when a complete set was recovered from a scan. */
  recoveredIds: bigint[] | null;
}

/**
 * Turn a Package's destination messages into ranged parts (fileId + size + name),
 * in upload order. Prefers the scan index (free) over `getMessage` (one API call
 * per part), and recovers the full set from the anchor message when
 * `destMessageIds` is empty.
 */
async function resolveDestParts(
  client: Client,
  pkg: BackfillPackage,
  chatTelegramId: bigint,
  index: DestIndex | undefined
): Promise<ResolvedDestParts | { error: string }> {
  const toRangedPart = (doc: ChatDocument): RangedPart => ({
    fileId: doc.fileId,
    fileSize: doc.fileSize,
    fileName: doc.fileName,
  });

  if (pkg.destMessageIds.length > 0) {
    const parts: RangedPart[] = [];
    for (const msgId of pkg.destMessageIds) {
      const cached = index?.byMessageId.get(msgId.toString());
      if (cached) {
        parts.push(toRangedPart(cached));
        continue;
      }
      const resolved = await fetchDocumentPart(client, chatTelegramId, msgId, pkg);
      if ("error" in resolved) return resolved;
      parts.push(resolved.part);
    }
    return { parts, recoveredIds: null };
  }

  if (!pkg.destMessageId) return { error: "package has no destination message id" };

  // A single-part package needs no recovery: its one message id is complete.
  if (pkg.partCount <= 1 && !pkg.isMultipart) {
    const cached = index?.byMessageId.get(pkg.destMessageId.toString());
    if (cached) return { parts: [toRangedPart(cached)], recoveredIds: null };
    const resolved = await fetchDocumentPart(client, chatTelegramId, pkg.destMessageId, pkg);
    if ("error" in resolved) return resolved;
    return { parts: [resolved.part], recoveredIds: null };
  }

  if (!index) {
    return {
      error:
        `destMessageIds is empty and the package has ${pkg.partCount} parts; ` +
        "destMessageId alone is only the first part. Re-run with recoverDestIds to scan the destination channel",
    };
  }

  const resolution = resolveDestPartSet(index, pkg.destMessageId, pkg.partCount);
  if (!resolution.ok) return { error: resolution.reason };

  return {
    parts: resolution.parts.map(toRangedPart),
    recoveredIds: resolution.parts.map((p) => p.id),
  };
}

async function fetchDocumentPart(
  client: Client,
  chatTelegramId: bigint,
  messageId: bigint,
  pkg: BackfillPackage
): Promise<{ part: RangedPart } | { error: string }> {
  const message = await invokeWithTimeout<{
    content?: { document?: { file_name?: string; document?: { id: number; size: number } } };
  }>(client, {
    _: "getMessage",
    chat_id: Number(chatTelegramId),
    message_id: Number(messageId),
  });
  const doc = message?.content?.document;
  if (!doc?.document?.id) {
    return { error: `destination message ${messageId} has no document` };
  }
  return {
    part: {
      fileId: String(doc.document.id),
      fileSize: BigInt(doc.document.size),
      fileName: doc.file_name ?? pkg.fileName,
    },
  };
}

async function repairOnePackage(
  client: Client,
  pkg: BackfillPackage,
  ctx: { packageId: string; fileName: string },
  plan: BackfillPlan,
  destIndexes: Map<string, DestIndex>,
  counters: BackfillCounters
): Promise<void> {
  if (!pkg.destChannelId || !pkg.destMessageId) {
    counters.skipped++;
    log.info({ ...ctx, reason: "no destination channel/message" }, "Backfill skipped");
    return;
  }

  const destChannel = await db.telegramChannel.findUnique({
    where: { id: pkg.destChannelId },
    select: { telegramId: true },
  });
  if (!destChannel) throw new Error("Destination channel not found in DB");

  const index = destIndexes.get(pkg.destChannelId);
  const resolved = await resolveDestParts(client, pkg, destChannel.telegramId, index);
  if ("error" in resolved) {
    counters.skipped++;
    log.info({ ...ctx, reason: resolved.error }, "Backfill skipped");
    return;
  }
  const { parts, recoveredIds } = resolved;

  // Persist a recovered part set before attempting the read: the ids are correct
  // regardless of whether the listing turns out to be readable, and recording
  // them is what makes the package repairable on any later attempt (and lets the
  // bot deliver every part rather than just the first).
  if (recoveredIds) {
    const written = await persistRecoveredDestIds(pkg.id, recoveredIds);
    if (written) {
      counters.idsRecovered++;
      log.info({ ...ctx, destMessageIds: recoveredIds.map(Number) }, "Recovered destination message ids");
    }
  }

  const route = planListingRead({
    archiveType: pkg.archiveType,
    sourceFileName: pkg.fileName,
    destFileNames: parts.map((p) => p.fileName),
    totalSize: parts.reduce((sum, p) => sum + p.fileSize, 0n),
    maxDownloadBytes: BigInt(config.maxZipSizeMB) * 1024n * 1024n,
    rangedOnly: plan.rangedOnly,
  });

  if (route.route === "skip") {
    counters.skipped++;
    if (/concat/.test(route.reason)) counters.concatUnlistable++;
    log.info(
      { ...ctx, reason: route.reason, destFileNames: parts.map((p) => p.fileName) },
      "Backfill skipped — destination copy cannot be listed"
    );
    return;
  }

  // ── Cheap path: read only the bytes that hold the listing ──
  log.info(
    { ...ctx, parts: parts.length, reason: route.reason },
    "Backfill reading listing via RANGED read (no full download)"
  );
  let entries = await readScannedListingRanged(pkg.archiveType, client, parts);
  let pathTaken: "ranged" | "download" = "ranged";

  if (!entries || entries.length === 0) {
    const totalSize = parts.reduce((sum, p) => sum + p.fileSize, 0n);
    const fallback = planRangedFallback({
      totalSize,
      maxDownloadBytes: BigInt(config.maxZipSizeMB) * 1024n * 1024n,
      rangedOnly: plan.rangedOnly,
    });
    if (fallback.route === "skip") {
      counters.skipped++;
      log.info({ ...ctx, reason: fallback.reason }, "Backfill skipped after ranged read returned nothing");
      return;
    }
    log.warn(
      { ...ctx, reason: fallback.reason, bytes: totalSize.toString() },
      "Backfill falling back to FULL DOWNLOAD"
    );
    entries = await downloadAndRead(client, pkg, parts);
    pathTaken = "download";
  }

  if (!entries || entries.length === 0) {
    counters.skipped++;
    log.warn({ ...ctx, pathTaken }, "Reader returned 0 entries — archive may be encrypted or corrupt");
    return;
  }

  await writeListing(pkg, entries, ctx);
  if (pathTaken === "ranged") counters.listedRanged++;
  else counters.listedDownload++;
  log.info({ ...ctx, fileCount: entries.length, pathTaken }, "Backfilled file list");
}

/**
 * Write `destMessageIds` for a package that had none. Guarded on the array still
 * being empty so a value written concurrently — by another worker, or by hand —
 * is never clobbered. Returns whether a row was actually updated.
 */
async function persistRecoveredDestIds(packageId: string, ids: bigint[]): Promise<boolean> {
  const result = await db.package.updateMany({
    where: { id: packageId, destMessageIds: { isEmpty: true } },
    data: { destMessageIds: ids },
  });
  return result.count > 0;
}

/** The original full-download path, kept as the fallback for un-ranged archives. */
async function downloadAndRead(
  client: Client,
  pkg: BackfillPackage,
  parts: RangedPart[]
): Promise<FileEntry[]> {
  const tempDir = path.join(config.tempDir, `backfill_${pkg.id}`);
  await mkdir(tempDir, { recursive: true });
  try {
    const partPaths: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const localPath = path.join(tempDir, part.fileName || `${pkg.id}.part${i + 1}`);
      await downloadFile(client, part.fileId, localPath, part.fileSize, part.fileName);
      partPaths.push(localPath);
    }

    if (pkg.archiveType === "ZIP") return readZipCentralDirectory(partPaths);
    // unrar / 7z auto-discover sibling parts when in the same directory
    if (pkg.archiveType === "RAR") return readRarContents(partPaths[0]);
    if (pkg.archiveType === "SEVEN_Z") return read7zContents(partPaths[0]);
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeListing(
  pkg: BackfillPackage,
  entries: FileEntry[],
  ctx: { packageId: string; fileName: string }
): Promise<void> {
  // Also derive slicer tags from the file list so the backfilled packages
  // gain the same search/filter context as newly-ingested ones.
  const slicerTags = extractSlicerTags(entries);

  // Write everything in a single transaction so a partial backfill never
  // leaves the Package half-indexed.
  await db.$transaction(async (tx) => {
    // Re-check fileCount inside the transaction: another worker might
    // have backfilled this package between our read and write.
    const current = await tx.package.findUnique({
      where: { id: pkg.id },
      select: { fileCount: true, tags: true },
    });
    if (current && current.fileCount > 0) {
      log.debug({ ...ctx, existingFileCount: current.fileCount }, "Already backfilled by another worker — skipping");
      return;
    }

    await tx.packageFile.deleteMany({ where: { packageId: pkg.id } });
    await tx.packageFile.createMany({
      data: entries.map((e) => ({
        packageId: pkg.id,
        path: e.path,
        fileName: e.fileName,
        extension: e.extension,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        crc32: e.crc32,
      })),
    });

    // Merge slicer tags with whatever's already on the Package (preserve
    // channel category, manual tags, etc.).
    const existingTags = current?.tags ?? [];
    const mergedTags = [...new Set([...existingTags, ...slicerTags])];

    await tx.package.update({
      where: { id: pkg.id },
      data: { fileCount: entries.length, tags: mergedTags },
    });
  });
}

/**
 * Cheap pure-DB backfill: walk Packages that already have PackageFile rows
 * but no slicer tags, recompute the tags from their extensions, and merge
 * with the existing tag list. No downloads, no TDLib.
 *
 * Trigger:
 *   SELECT pg_notify('backfill_slicer_tags', '{"limit":1000}');
 */
export async function processSlicerTagBackfill(payloadJson: string): Promise<void> {
  let limit = 1000;
  try {
    const parsed = JSON.parse(payloadJson) as { limit?: number };
    if (typeof parsed.limit === "number" && parsed.limit > 0) limit = parsed.limit;
  } catch {
    // Use default
  }

  // KNOWN_TAGS = the slicer tags we know how to derive. A Package missing
  // all of these is a candidate for recompute. extractSlicerTags is safe
  // to run on every package (returns [] for archives with no slicer files),
  // but filtering up-front avoids walking the entire DB.
  const KNOWN_TAGS = ["lychee", "chitubox", "anycubic", "bambu", "fdm", "mango"];

  const candidates = await db.package.findMany({
    where: {
      fileCount: { gt: 0 },
      NOT: { tags: { hasSome: KNOWN_TAGS } },
    },
    select: {
      id: true,
      tags: true,
      files: { select: { extension: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (candidates.length === 0) {
    log.info("Slicer tag backfill: no candidates");
    return;
  }

  log.info({ count: candidates.length }, "Slicer tag backfill: starting");

  let updated = 0;
  for (const pkg of candidates) {
    const fileEntries = pkg.files.map((f) => ({
      path: "",
      fileName: "",
      extension: f.extension,
      compressedSize: 0n,
      uncompressedSize: 0n,
      crc32: null as string | null,
    }));
    const slicerTags = extractSlicerTags(fileEntries);
    if (slicerTags.length === 0) continue;
    const merged = [...new Set([...pkg.tags, ...slicerTags])];
    if (merged.length === pkg.tags.length) continue;
    await db.package.update({ where: { id: pkg.id }, data: { tags: merged } });
    updated++;
  }

  log.info({ candidates: candidates.length, updated }, "Slicer tag backfill: done");
}
