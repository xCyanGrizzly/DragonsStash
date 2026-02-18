"use server";

import { signIn } from "@/lib/auth";
import { loginSchema } from "@/schemas/auth.schema";
import { AuthError } from "next-auth";

export async function loginAction(values: { email: string; password: string }) {
  const parsed = loginSchema.safeParse(values);
  if (!parsed.success) {
    return { error: "Invalid email or password" };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return { error: "Invalid email or password" };
        default:
          return { error: "Something went wrong" };
      }
    }
    // This is a redirect error thrown by next-auth on success - rethrow it
    throw error;
  }
}
