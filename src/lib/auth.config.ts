import type { NextAuthConfig } from "next-auth";

export default {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isAuthPage =
        nextUrl.pathname.startsWith("/login") || nextUrl.pathname.startsWith("/register");
      const isApiAuth = nextUrl.pathname.startsWith("/api/auth");
      const isHealth = nextUrl.pathname.startsWith("/api/health");

      if (isHealth || isApiAuth) return true;
      if (isAuthPage) {
        if (isLoggedIn) return Response.redirect(new URL("/dashboard", nextUrl));
        return true;
      }
      return isLoggedIn;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
