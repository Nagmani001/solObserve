"use client";

import { useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@repo/ui/lib/toast";
import { Button } from "@repo/ui/components/button";
import { Bell, Database, Atom } from "lucide-react";
import { countAtom } from "@/atom";

function JotaiDemo() {
  const [count, setCount] = useAtom(countAtom);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Atom className="size-5" />
        </div>
        <h3 className="font-semibold">Jotai</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Global atom state. The count persists across re-renders.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCount((c) => c - 1)}
        >
          -
        </Button>
        <span className="min-w-[3ch] text-center text-lg font-bold tabular-nums">
          {count}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCount((c) => c + 1)}
        >
          +
        </Button>
      </div>
    </div>
  );
}

// --- React Query demo ---
function ReactQueryDemo() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["demo-todo"],
    queryFn: async () => {
      const id = Math.floor(Math.random() * 200) + 1;
      const res = await fetch(
        `https://jsonplaceholder.typicode.com/todos/${id}`,
      );
      return res.json() as Promise<{
        id: number;
        title: string;
        completed: boolean;
      }>;
    },
  });

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Database className="size-5" />
        </div>
        <h3 className="font-semibold">React Query</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Fetches a random todo from an API. Cached &amp; auto-managed.
      </p>
      <div className="mb-3 min-h-[3rem] rounded-md bg-muted p-3 text-sm">
        {isFetching ? (
          <span className="text-muted-foreground">Loading...</span>
        ) : data ? (
          <span>
            <span className="font-medium">#{data.id}:</span> {data.title}{" "}
            {data.completed ? "✓" : "○"}
          </span>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => refetch()}
        disabled={isFetching}
      >
        Fetch random todo
      </Button>
    </div>
  );
}

// --- Toast demo ---
function ToastDemo() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bell className="size-5" />
        </div>
        <h3 className="font-semibold">Toast (Sonner)</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Trigger different toast variants with a single function call.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => toast.success("Action completed!")}>
          Success
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => toast.error("Something went wrong.")}
        >
          Error
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => toast.info("Here is some info.")}
        >
          Info
        </Button>
      </div>
    </div>
  );
}

export function DemoSection() {
  return (
    <section className="border-t px-4 py-20">
      <div className="mx-auto max-w-screen-xl">
        <h2 className="mb-4 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Try it out
        </h2>
        <p className="mb-12 text-center text-muted-foreground">
          Interactive demos — toast, global state, and server data fetching.
        </p>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <ToastDemo />
          <JotaiDemo />
          <ReactQueryDemo />
        </div>
      </div>
    </section>
  );
}
