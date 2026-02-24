import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Authenticate an API request. Checks:
 * 1. X-API-Key header against TELEGRAM_API_KEY env var
 * 2. NextAuth session
 *
 * Returns null if authenticated, or a NextResponse error if not.
 */
export async function authenticateApiRequest(
  request: Request,
  requireAdmin = false
): Promise<{ error: NextResponse } | { userId: string; role: string }> {
  // Check API key first
  const apiKey = request.headers.get("X-API-Key");
  const envKey = process.env.TELEGRAM_API_KEY;

  if (apiKey && envKey && apiKey === envKey) {
    // API key auth — treated as admin
    return { userId: "api-key", role: "ADMIN" };
  }

  // Fall back to session auth
  const session = await auth();
  if (!session?.user?.id) {
    return {
      error: NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }

  if (requireAdmin && session.user.role !== "ADMIN") {
    return {
      error: NextResponse.json(
        { error: "Forbidden: admin role required" },
        { status: 403 }
      ),
    };
  }

  return { userId: session.user.id, role: session.user.role };
}
