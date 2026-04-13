import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  //BUG: bad
  baseURL: process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001",
  plugins: [emailOTPClient()],
});
