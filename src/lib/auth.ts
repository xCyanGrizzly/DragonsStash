import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import authConfig from "@/lib/auth.config";
import { loginSchema } from "@/schemas/auth.schema";
import "@/types/auth.types";

export const { auth, handlers, signIn, signOut } = NextAuth({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: PrismaAdapter(prisma) as any,
  session: { strategy: "jwt" },
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        // Fetch the role from the database to pick up first-user ADMIN promotion
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id! },
          select: { role: true },
        });
        token.role = dbUser?.role ?? user.role ?? "USER";
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as "ADMIN" | "USER";
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        // First user to register becomes ADMIN (self-hosted owner)
        const adminExists = await prisma.user.findFirst({
          where: { role: "ADMIN" },
          select: { id: true },
        });
        if (!adminExists) {
          await prisma.user.update({
            where: { id: user.id },
            data: { role: "ADMIN" },
          });
        }

        await prisma.userSettings.upsert({
          where: { userId: user.id },
          update: {},
          create: {
            userId: user.id,
            lowStockThreshold: 10,
            currency: "USD",
            theme: "dark",
            units: "metric",
          },
        });
      }
    },
  },
  providers: [
    Credentials({
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user || !user.hashedPassword) return null;

        const passwordMatch = await bcrypt.compare(parsed.data.password, user.hashedPassword);
        if (!passwordMatch) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        };
      },
    }),
    ...(process.env.AUTH_GITHUB_ID
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
          }),
        ]
      : []),
  ],
});
