import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getLinkedPackageIds } from "@/data/kickstarter.queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const kickstarterId = searchParams.get("kickstarterId");
  if (!kickstarterId) {
    return NextResponse.json({ error: "kickstarterId required" }, { status: 400 });
  }

  const packageIds = await getLinkedPackageIds(kickstarterId);
  return NextResponse.json({ packageIds });
}
