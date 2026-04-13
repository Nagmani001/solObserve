"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogClose } from "@repo/ui/components/dialog";
import { OtpInput } from "@repo/ui/components/input-otp";
import { Button } from "@repo/ui/components/button";
import { X } from "lucide-react";
import { authTheme, getAuthThemeVars } from "@/lib/auth-theme";

interface OtpDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  onSubmit: (otp: string) => void;
  onResend: () => void;
  isLoading?: boolean;
}

export function OtpDialog({
  isOpen,
  onOpenChange,
  email,
  onSubmit,
  onResend,
  isLoading = false,
}: OtpDialogProps) {
  const [otp, setOtp] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length === 6) {
      onSubmit(otp);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        style={getAuthThemeVars(authTheme.defaultColors)}
        className="max-w-md rounded-2xl border border-[var(--auth-border)] bg-[var(--auth-surface)] p-8 shadow-[0_28px_90px_-45px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.04)]"
      >
        <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity outline-none">
          <X className="size-4 text-[var(--auth-text-muted)]" />
          <span className="sr-only">Close</span>
        </DialogClose>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-[var(--auth-text)]">
              Verify your email
            </h2>
            <p className="mt-2 text-sm text-[var(--auth-text-muted)]">
              Enter the 6-digit code sent to{" "}
              <span className="font-medium text-[var(--auth-text)]">
                {email}
              </span>
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <OtpInput
              value={otp}
              onChange={setOtp}
              disabled={isLoading}
              inputClassName="bg-[var(--auth-surface-strong)] border-[var(--auth-border)] text-[var(--auth-text)] focus:border-[var(--auth-color-primary)] focus:ring-[var(--auth-color-primary)]"
            />

            <Button
              type="submit"
              disabled={otp.length !== 6 || isLoading}
              className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] py-3 text-sm font-semibold text-[var(--app-color-foreground)] shadow-[0_18px_32px_-18px_var(--auth-color-primary)] hover:brightness-105"
            >
              {isLoading ? "Verifying..." : "Verify Email"}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-[var(--auth-text-muted)]">
            Didn&apos;t receive a code?{" "}
            <button
              type="button"
              onClick={onResend}
              disabled={isLoading}
              className="text-[var(--auth-color-primary)] hover:underline disabled:opacity-50"
            >
              Resend
            </button>
          </p>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
