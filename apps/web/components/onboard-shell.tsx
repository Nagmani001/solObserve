"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export type OnboardStep = {
  index: number;
  label: string;
  href?: string;
  status: "done" | "active" | "pending";
};

interface OnboardShellProps {
  steps: OnboardStep[];
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  userLabel?: string;
}

const tokens = {
  ["--bg" as string]: "oklch(98.5% 0.004 80)",
  ["--bg-elevated" as string]: "oklch(100% 0 0)",
  ["--bg-sunken" as string]: "oklch(96.5% 0.005 80)",
  ["--ink" as string]: "oklch(18% 0.018 250)",
  ["--ink-mid" as string]: "oklch(45% 0.012 250)",
  ["--ink-faint" as string]: "oklch(65% 0.008 250)",
  ["--line" as string]: "oklch(90% 0.006 80)",
  ["--line-strong" as string]: "oklch(82% 0.008 80)",
  ["--accent" as string]: "oklch(58% 0.17 45)",
  ["--accent-soft" as string]: "oklch(95% 0.04 45)",
};

export function OnboardShell({
  steps,
  eyebrow,
  title,
  description,
  children,
  footer,
  userLabel,
}: OnboardShellProps) {
  return (
    <div
      style={{ ...tokens, background: "var(--bg)" } as React.CSSProperties}
      className="fixed inset-0 z-40 w-full overflow-auto text-[var(--ink)]"
    >
      <div
        className="grid min-h-screen"
        style={{ gridTemplateColumns: "minmax(220px, 320px) 1fr" }}
      >
        <aside
          className="hidden md:flex flex-col justify-between border-r"
          style={{
            background: "var(--bg-sunken)",
            borderColor: "var(--line)",
            padding: "32px 24px",
          }}
        >
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: "var(--accent)" }}
              />
              <span
                className="text-[15px] font-semibold tracking-tight"
                style={{ color: "var(--ink)" }}
              >
                SolObserve
              </span>
            </Link>

            <nav className="mt-10">
              <ol className="space-y-1">
                {steps.map((s) => (
                  <StepRow key={s.index} step={s} />
                ))}
              </ol>
            </nav>
          </div>

          {userLabel ? (
            <div
              className="border-t pt-4 text-[11px] font-mono"
              style={{
                borderColor: "var(--line)",
                color: "var(--ink-faint)",
              }}
            >
              {userLabel}
            </div>
          ) : null}
        </aside>

        <main style={{ background: "var(--bg)" }} className="flex flex-col">
          <div className="flex-1 px-6 md:px-12 lg:px-16 py-12 md:py-20">
            <div className="max-w-[460px]">
              {eyebrow ? (
                <div
                  className="text-[11px] font-medium uppercase tracking-[0.08em] mb-3"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {eyebrow}
                </div>
              ) : null}
              <h1
                className="text-[28px] font-semibold leading-tight tracking-tight"
                style={{ color: "var(--ink)" }}
              >
                {title}
              </h1>
              {description ? (
                <p
                  className="mt-2 text-[14px] leading-relaxed"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {description}
                </p>
              ) : null}
              <div
                className="my-7 h-px"
                style={{ background: "var(--line)" }}
              />
              <div>{children}</div>
            </div>
          </div>

          {footer ? (
            <div
              className="border-t px-6 md:px-12 lg:px-16 py-5 text-[13px]"
              style={{
                borderColor: "var(--line)",
                color: "var(--ink-mid)",
              }}
            >
              {footer}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: OnboardStep }) {
  const isActive = step.status === "active";
  const isDone = step.status === "done";
  const numColor = isActive
    ? "var(--accent)"
    : isDone
      ? "var(--ink-mid)"
      : "var(--ink-faint)";
  const textColor = isActive
    ? "var(--ink)"
    : isDone
      ? "var(--ink-mid)"
      : "var(--ink-faint)";

  const inner = (
    <span
      className="flex items-center gap-3 py-1.5 text-[13px]"
      style={{ color: textColor, fontWeight: isActive ? 500 : 400 }}
    >
      <span
        className="font-mono text-[11px] tabular-nums"
        style={{ color: numColor }}
      >
        {String(step.index).padStart(2, "0")}
      </span>
      <span>{step.label}</span>
      {isActive ? (
        <span
          className="ml-auto inline-block size-1.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
      ) : null}
    </span>
  );

  if (step.href && !isActive) {
    return (
      <li>
        <Link href={step.href} className="block hover:opacity-80">
          {inner}
        </Link>
      </li>
    );
  }
  return <li>{inner}</li>;
}

export const ONBOARD_STEPS: Omit<OnboardStep, "status">[] = [
  { index: 1, label: "Sign in" },
  { index: 2, label: "Workspace" },
  { index: 3, label: "Project" },
  { index: 4, label: "Program" },
];

export function withStatus(activeIdx: number): OnboardStep[] {
  return ONBOARD_STEPS.map((s) => ({
    ...s,
    status:
      s.index < activeIdx
        ? "done"
        : s.index === activeIdx
          ? "active"
          : "pending",
  }));
}
