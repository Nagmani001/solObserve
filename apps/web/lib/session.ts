import { cookies } from "next/headers";
import { getBackendUrl } from "./util";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

export async function getCookieHeader(): Promise<string | null> {
  const store = await cookies();
  const all = store.getAll();
  if (!all.length) return null;
  return all.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Resolves Better Auth session via backend (cookie forwarded). */
export async function fetchBackendSession(): Promise<SessionUser | null> {
  const cookieHeader = await getCookieHeader();
  if (!cookieHeader) return null;

  const base = getBackendUrl();
  const urls = [`${base}/api/auth/get-session`, `${base}/api/auth/session`];

  for (const url of urls) {
    const res = await fetch(url, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!data) continue;
    const userRaw = data.user as SessionUser | undefined | null;
    if (userRaw?.id) return userRaw;
  }

  return null;
}
