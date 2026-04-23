export function getBackendUrl() {
  const u =
    process.env.BACKEND_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "");
  return u || "http://localhost:3001";
}
