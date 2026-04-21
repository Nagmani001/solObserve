export function getBackendUrl() {
  if (typeof window === "undefined") {
    return "http://backend:3001";
  }
  return "http://localhost:3001";
}
