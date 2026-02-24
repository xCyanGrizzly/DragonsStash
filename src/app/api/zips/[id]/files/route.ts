import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { listPackageFiles } from "@/lib/telegram/queries";
import { listFilesSchema } from "@/schemas/telegram";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const parsed = listFilesSchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listPackageFiles({
    packageId: id,
    ...parsed.data,
  });

  return NextResponse.json(result);
}
