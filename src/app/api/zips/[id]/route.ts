import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { getPackageById } from "@/lib/telegram/queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;
  const pkg = await getPackageById(id);

  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  return NextResponse.json(pkg);
}
