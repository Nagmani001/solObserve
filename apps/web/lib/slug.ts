export function slugFromName(name: string, suffix?: string): string {
  let s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!s.length) {
    s = "org";
  }
  return suffix ? `${s}-${suffix}` : s;
}
