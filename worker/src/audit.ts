import { db } from "./db/client.js";
import { childLogger } from "./util/logger.js";

const log = childLogger("audit");

/**
 * Periodic integrity audit: checks all packages for consistency.
 * Creates SystemNotification records for any issues found.
 *
 * Checks performed:
 * 1. Multipart completeness: destMessageIds.length should match partCount
 * 2. Missing destination: packages with destChannelId but no destMessageId
 */
export async function runIntegrityAudit(): Promise<{ checked: number; issues: number }> {
  log.info("Starting integrity audit");

  let checked = 0;
  let issues = 0;

  // Check 1: Multipart packages with wrong number of destination message IDs
  const multipartPackages = await db.package.findMany({
    where: {
      isMultipart: true,
      partCount: { gt: 1 },
      destMessageId: { not: null },
    },
    select: {
      id: true,
      fileName: true,
      partCount: true,
      destMessageIds: true,
      sourceChannelId: true,
      sourceChannel: { select: { title: true } },
    },
  });

  checked += multipartPackages.length;

  for (const pkg of multipartPackages) {
    const actualParts = pkg.destMessageIds.length;
    if (actualParts > 0 && actualParts !== pkg.partCount) {
      issues++;

      // Check if we already have a notification for this
      const existing = await db.systemNotification.findFirst({
        where: {
          type: "MISSING_PART",
          context: { path: ["packageId"], equals: pkg.id },
        },
        select: { id: true },
      });

      if (!existing) {
        await db.systemNotification.create({
          data: {
            type: "MISSING_PART",
            severity: "WARNING",
            title: `Incomplete multipart: ${pkg.fileName}`,
            message: `Expected ${pkg.partCount} parts but only ${actualParts} destination message IDs stored`,
            context: {
              packageId: pkg.id,
              fileName: pkg.fileName,
              expectedParts: pkg.partCount,
              actualParts,
              sourceChannelId: pkg.sourceChannelId,
              channelTitle: pkg.sourceChannel.title,
            },
          },
        });

        log.warn(
          { packageId: pkg.id, fileName: pkg.fileName, expected: pkg.partCount, actual: actualParts },
          "Multipart package has mismatched part count"
        );
      }
    }
  }

  // Check 2: Packages with dest channel but no dest message (orphaned index)
  const orphanedCount = await db.package.count({
    where: {
      destChannelId: { not: null },
      destMessageId: null,
    },
  });

  if (orphanedCount > 0) {
    issues++;

    const existing = await db.systemNotification.findFirst({
      where: {
        type: "INTEGRITY_AUDIT",
        context: { path: ["check"], equals: "orphaned_index" },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      select: { id: true },
    });

    if (!existing) {
      await db.systemNotification.create({
        data: {
          type: "INTEGRITY_AUDIT",
          severity: "INFO",
          title: `${orphanedCount} packages with missing destination message`,
          message: `Found ${orphanedCount} packages that have a destination channel set but no destination message ID. These may be from interrupted uploads.`,
          context: {
            check: "orphaned_index",
            count: orphanedCount,
          },
        },
      });
    }
  }

  log.info({ checked, issues }, "Integrity audit complete");
  return { checked, issues };
}
