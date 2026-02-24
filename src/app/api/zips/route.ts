import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { listPackages } from "@/lib/telegram/queries";
import { listPackagesSchema } from "@/schemas/telegram";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { searchParams } = new URL(request.url);
  const parsed = listPackagesSchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listPackages(parsed.data);
  return NextResponse.json(result);
}
