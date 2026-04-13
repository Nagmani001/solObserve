"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { cn } from "@repo/ui/lib/utils";
import type { AuthThemeColors } from "@/lib/auth-theme";
import { getAuthThemeVars } from "@/lib/auth-theme";

interface GenericAuthPageProps {
  title: string;
  subtitle: string;
  footerLabel: string;
  footerHref: string;
  footerHrefLabel: string;
  children: ReactNode;
  colors?: AuthThemeColors;
}

export function GenericAuthPage({
  title,
  subtitle,
  footerLabel,
  footerHref,
  footerHrefLabel,
  children,
  colors,
}: GenericAuthPageProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      style={getAuthThemeVars(colors)}
      className={cn(
        "relative z-10 w-full max-w-md rounded-2xl border border-[var(--auth-border)] bg-[var(--auth-surface)] p-8 shadow-[0_28px_90px_-45px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur-md",
      )}
    >
      <div className="text-center mb-8">
        <Link href="/" className="inline-flex items-center gap-2 mb-6">
          <div className="grid size-8 place-items-center rounded-full border border-[var(--auth-border)] bg-[var(--auth-surface)] text-xs font-bold text-[var(--auth-text)]">
            T
          </div>
          <span className="text-lg font-bold text-[var(--auth-text)]">
            Template
          </span>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--auth-text)]">{title}</h1>
        <p className="mt-1 text-sm text-[var(--auth-text-muted)]">{subtitle}</p>
      </div>

      {children}

      <p className="mt-6 text-center text-sm text-[var(--auth-text-muted)]">
        {footerLabel}{" "}
        <Link
          href={footerHref}
          className="font-medium text-[var(--auth-color-primary)] hover:underline"
        >
          {footerHrefLabel}
        </Link>
      </p>
    </motion.div>
  );
}
