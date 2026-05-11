import { redirect } from "next/navigation";
import { fetchBackendSession } from "@/lib/session";
import { HealthIndicator } from "@/components/health-indicator";

export default async function Home() {
  const session = await fetchBackendSession();
  if (session) redirect("/orgs");

  return (
    <main className="flex min-h-[calc(100vh-3rem)] items-center justify-center px-4">
      <section
        className="w-full max-w-md rounded p-8"
        style={{
          background: "oklch(100% 0 0)",
          border: "1px solid oklch(90% 0.006 80)",
        }}
      >
        <h1
          className="text-[24px] font-semibold tracking-tight"
          style={{ color: "oklch(18% 0.018 250)" }}
        >
          SolObserve
        </h1>
        <p
          className="mt-2 text-[13px]"
          style={{ color: "oklch(45% 0.012 250)" }}
        >
          Zero-config observability for Solana programs.
        </p>
        <div className="mt-6 flex items-center gap-4">
          <HealthIndicator />
          <a
            href="/signin"
            className="ml-auto text-[13px] font-medium hover:opacity-80"
            style={{ color: "oklch(58% 0.17 45)" }}
          >
            Sign in →
          </a>
        </div>
      </section>
    </main>
  );
}
