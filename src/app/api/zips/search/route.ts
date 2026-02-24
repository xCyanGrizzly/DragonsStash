import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { searchPackages } from "@/lib/telegram/queries";
import { searchSchema } from "@/schemas/telegram";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { searchParams } = new URL(request.url);
  const parsed = searchSchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { q, ...rest } = parsed.data;
  const result = await searchPackages({ query: q, ...rest });
  return NextResponse.json(result);
}
