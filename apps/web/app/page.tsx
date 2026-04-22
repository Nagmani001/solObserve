import { HealthIndicator } from "@/components/health-indicator";

export default function Home() {
  return (
    <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
      <section className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">SolObserve</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Zero-config observability for Solana programs.
        </p>
        <div className="mt-6">
          <HealthIndicator />
        </div>
      </section>
    </main>
  );
}
