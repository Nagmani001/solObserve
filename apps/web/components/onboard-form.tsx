"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { forwardRef } from "react";
import { cn } from "@repo/ui/lib/utils";

export function FieldLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em]"
      style={{ color: "var(--ink-mid)" }}
    >
      {children}
    </label>
  );
}

export const FieldInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function FieldInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      {...rest}
      className={cn(
        "w-full text-[14px] outline-none transition-colors",
        "px-3 py-2.5 rounded",
        className,
      )}
      style={{
        background: "oklch(100% 0 0)",
        color: "oklch(18% 0.018 250)",
        border: "1px solid oklch(90% 0.006 80)",
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "oklch(58% 0.17 45)";
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "oklch(90% 0.006 80)";
        rest.onBlur?.(e);
      }}
    />
  );
});

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-1.5 text-[12px]" style={{ color: "oklch(55% 0.18 25)" }}>
      {children}
    </p>
  );
}

export function FieldHint({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-1.5 text-[12px] leading-relaxed"
      style={{ color: "var(--ink-faint)" }}
    >
      {children}
    </p>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
};

export const PrimaryButton = forwardRef<HTMLButtonElement, BtnProps>(
  function PrimaryButton(
    { className, variant = "primary", style, disabled, ...rest },
    ref,
  ) {
    const base =
      "inline-flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-medium rounded transition-colors disabled:cursor-not-allowed";
    if (variant === "primary") {
      return (
        <button
          ref={ref}
          disabled={disabled}
          {...rest}
          className={cn(base, className)}
          style={
            disabled
              ? {
                  background: "oklch(92% 0.005 80)",
                  color: "oklch(65% 0.008 250)",
                  border: "1px solid oklch(88% 0.006 80)",
                  ...style,
                }
              : {
                  background: "oklch(58% 0.17 45)",
                  color: "white",
                  border: "1px solid oklch(50% 0.17 45)",
                  ...style,
                }
          }
        />
      );
    }
    if (variant === "secondary") {
      return (
        <button
          ref={ref}
          {...rest}
          className={cn(base, className)}
          style={{
            background: "transparent",
            color: "var(--ink)",
            border: "1px solid var(--line-strong)",
            ...style,
          }}
        />
      );
    }
    return (
      <button
        ref={ref}
        {...rest}
        className={cn(base, className)}
        style={{
          background: "transparent",
          color: "var(--ink-mid)",
          border: "1px solid transparent",
          ...style,
        }}
      />
    );
  },
);

export function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="h-px flex-1" style={{ background: "var(--line)" }} />
      <span
        className="text-[10px] font-medium uppercase tracking-[0.1em]"
        style={{ color: "var(--ink-faint)" }}
      >
        {label}
      </span>
      <div className="h-px flex-1" style={{ background: "var(--line)" }} />
    </div>
  );
}
