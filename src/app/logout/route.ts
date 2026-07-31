import { signOut } from "@/lib/auth";

// Server-side sign-out that clears the JWT session cookie and redirects to the
// login page. Used to recover from a stale session whose user no longer exists
// in the database (e.g. after a DB reset), which a client-only signOut can't
// reach because the app crashes before rendering the user menu.
export async function GET() {
  await signOut({ redirectTo: "/login" });
}
