import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchPackagesForLinking } from "@/data/kickstarter.queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 50);

  const packages = await searchPackagesForLinking(query, limit);

  // Serialize BigInt for JSON
  const serialized = packages.map((p) => ({
    ...p,
    fileSize: p.fileSize.toString(),
  }));

  return NextResponse.json({ packages: serialized });
}
