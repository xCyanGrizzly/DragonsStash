import { describe, it, expect } from "vitest";
import {
  parseBackfillPayload,
  parseFileNameLike,
  MAX_BACKFILL_LIMIT,
  DEFAULT_BACKFILL_LIMIT,
} from "./backfill-scope.js";

/** The plan of a payload that must parse; fails the test if it doesn't. */
function planOf(payload: string) {
  const parsed = parseBackfillPayload(payload);
  if (!parsed.ok) throw new Error(`expected payload to parse, got: ${parsed.error}`);
  return parsed.plan;
}

function errorOf(payload: string): string {
  const parsed = parseBackfillPayload(payload);
  if (parsed.ok) throw new Error(`expected payload to be rejected, got plan: ${parsed.plan.describe}`);
  return parsed.error;
}

describe("parseBackfillPayload — refusing the unbounded sweep", () => {
  it("rejects an empty payload rather than selecting every empty package", () => {
    expect(errorOf("{}")).toMatch(/refusing an unbounded backfill/);
    expect(errorOf("")).toMatch(/refusing an unbounded backfill/);
  });

  it("rejects a payload that only names an archiveType", () => {
    // This is the shape that used to select 4,330 packages / 5.4TB.
    expect(errorOf('{"archiveType":"ZIP"}')).toMatch(/refusing an unbounded backfill/);
  });

  it("rejects invalid JSON and non-object payloads", () => {
    expect(errorOf("not json")).toMatch(/not valid JSON/);
    expect(errorOf("[]")).toMatch(/must be a JSON object/);
    expect(errorOf("null")).toMatch(/must be a JSON object/);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    // A typo'd selector must not silently degrade into "no selector".
    expect(errorOf('{"packageIDs":["abc"]}')).toMatch(/unknown field\(s\): packageIDs/);
  });

  it("allows the broad sweep only when it asks for itself", () => {
    const plan = planOf('{"archiveType":"RAR","limit":50,"allowBroadSweep":true}');
    expect(plan.selector).toEqual({ archiveType: "RAR" });
    expect(plan.limit).toBe(50);
  });

  it("rejects allowBroadSweep combined with a selector as a contradiction", () => {
    expect(errorOf('{"fileNameLike":"%.z01","allowBroadSweep":true}')).toMatch(/unscoped sweeps only/);
  });
});

describe("parseBackfillPayload — packageIds", () => {
  it("accepts, trims and de-duplicates an explicit id list", () => {
    const plan = planOf('{"packageIds":[" abc123 ","abc123","def456"]}');
    expect(plan.selector.packageIds).toEqual(["abc123", "def456"]);
  });

  it("rejects an empty list, non-strings and non-identifier ids", () => {
    expect(errorOf('{"packageIds":[]}')).toMatch(/must not be empty/);
    expect(errorOf('{"packageIds":[1,2]}')).toMatch(/only strings/);
    expect(errorOf('{"packageIds":["a\'; DROP TABLE packages--"]}')).toMatch(/not a valid identifier/);
    expect(errorOf('{"packageIds":"abc"}')).toMatch(/must be an array/);
  });
});

describe("parseFileNameLike", () => {
  it("maps the four accepted wildcard positions to Prisma filters", () => {
    expect(parseFileNameLike("%.z01")).toEqual({ endsWith: ".z01" });
    expect(parseFileNameLike("Dragon%")).toEqual({ startsWith: "Dragon" });
    expect(parseFileNameLike("%dragon%")).toEqual({ contains: "dragon" });
    expect(parseFileNameLike("Pack.z01")).toEqual({ equals: "Pack.z01" });
  });

  it("refuses patterns that would match far more than intended", () => {
    expect(parseFileNameLike("%")).toHaveProperty("error");
    expect(parseFileNameLike("%%")).toHaveProperty("error");
    expect(parseFileNameLike("  ")).toHaveProperty("error");
    // Too little literal text to be a meaningful scope
    expect(parseFileNameLike("%a%")).toHaveProperty("error");
  });

  it("refuses interior and underscore wildcards rather than mis-translating them", () => {
    expect(parseFileNameLike("%.z%1")).toMatchObject({ error: expect.stringMatching(/interior wildcard/) });
    expect(parseFileNameLike("%.z0_")).toMatchObject({ error: expect.stringMatching(/_ wildcard/) });
  });
});

describe("parseBackfillPayload — limits and flags", () => {
  it("defaults the limit and caps it", () => {
    expect(planOf('{"fileNameLike":"%.z01"}').limit).toBe(DEFAULT_BACKFILL_LIMIT);
    expect(errorOf(`{"fileNameLike":"%.z01","limit":${MAX_BACKFILL_LIMIT + 1}}`)).toMatch(/exceeds the maximum/);
    expect(errorOf('{"fileNameLike":"%.z01","limit":0}')).toMatch(/positive integer/);
    expect(errorOf('{"fileNameLike":"%.z01","limit":1.5}')).toMatch(/positive integer/);
  });

  it("defaults rangedOnly and recoverDestIds off, and requires booleans", () => {
    const plan = planOf('{"fileNameLike":"%.z01"}');
    expect(plan.rangedOnly).toBe(false);
    expect(plan.recoverDestIds).toBe(false);
    expect(errorOf('{"fileNameLike":"%.z01","rangedOnly":"yes"}')).toMatch(/rangedOnly must be a boolean/);
  });

  it("parses the full spanned-ZIP repair payload", () => {
    const plan = planOf(
      '{"fileNameLike":"%.z01","archiveType":"ZIP","limit":250,"rangedOnly":true,"recoverDestIds":true}'
    );
    expect(plan.selector).toEqual({ fileName: { endsWith: ".z01" }, archiveType: "ZIP" });
    expect(plan.limit).toBe(250);
    expect(plan.rangedOnly).toBe(true);
    expect(plan.recoverDestIds).toBe(true);
    expect(plan.describe).toContain('fileName.endsWith=".z01"');
    expect(plan.describe).toContain("rangedOnly");
  });

  it("rejects an unsupported archiveType", () => {
    expect(errorOf('{"fileNameLike":"%.z01","archiveType":"TAR"}')).toMatch(/archiveType must be one of/);
  });
});
