import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { magicLinkClient } from "better-auth/client/plugins";
import { getBackendUrl } from "./util";

export const authClient = createAuthClient({
  baseURL: getBackendUrl(),
  plugins: [emailOTPClient(), magicLinkClient()],
});
