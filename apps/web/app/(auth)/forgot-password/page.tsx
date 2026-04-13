"use client";

import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import { useRouter } from "next/navigation";
import { GenericAuthPage } from "@/components/generic-auth-page";
import { OtpDialog } from "@/components/otp-dialogue";
import { emailSchema, passwordSchema } from "@repo/common/zodTypes";

export default function Page() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string>();
  const [otpOpen, setOtpOpen] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordErrors, setPasswordErrors] = useState<{
    password?: string;
    confirmPassword?: string;
  }>({});

  const [step, setStep] = useState<"email" | "reset">("email");
  const [verifiedOtp, setVerifiedOtp] = useState("");

  const router = useRouter();

  const sendOtpMutation = useMutation({
    mutationFn: async (emailInput: string) => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: emailInput,
        type: "forget-password",
      });
      if (error) {
        toast.error(error.message);
        throw error;
      }
      toast.success("Verification code sent to your email");
      setOtpOpen(true);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const resetMutation = useMutation({
    mutationFn: async ({
      newPassword,
      otp,
    }: {
      newPassword: string;
      otp: string;
    }) => {
      const res = await authClient.emailOtp.resetPassword({
        email,
        otp,
        password: newPassword,
      });
      if (res.error) {
        toast.error(res.error.message);
        throw res.error;
      }
      toast.success("Password reset successfully!");
      router.push("/signin");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse({ email });
    if (!parsed.success) {
      setEmailError(parsed.error.flatten().fieldErrors.email?.[0]);
      return;
    }
    setEmailError(undefined);
    sendOtpMutation.mutate(email);
  }

  function handleOtpVerified(otp: string) {
    setVerifiedOtp(otp);
    setOtpOpen(false);
    setStep("reset");
  }

  function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = passwordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setPasswordErrors({
        password: fieldErrors.password?.[0],
        confirmPassword: fieldErrors.confirmPassword?.[0],
      });
      return;
    }
    setPasswordErrors({});
    resetMutation.mutate({ newPassword: password, otp: verifiedOtp });
  }

  return (
    <GenericAuthPage
      title={step === "email" ? "Reset your password" : "Set new password"}
      subtitle={
        step === "email"
          ? "Enter your email to receive a verification code"
          : "Enter your new password"
      }
      footerLabel="Remember your password?"
      footerHref="/signin"
      footerHrefLabel="Sign in"
    >
      {step === "email" ? (
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <div>
            <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
              Email
            </Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(undefined);
              }}
              className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              placeholder="you@example.com"
            />
            {emailError && (
              <p className="mt-1 text-sm text-destructive">{emailError}</p>
            )}
          </div>
          <Button
            type="submit"
            disabled={sendOtpMutation.isPending}
            className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] py-3 text-sm font-semibold text-[var(--app-color-foreground)] shadow-[0_18px_32px_-18px_var(--auth-color-primary)] hover:brightness-105"
          >
            {sendOtpMutation.isPending
              ? "Sending..."
              : "Send Verification Code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleResetSubmit} className="space-y-4">
          <div>
            <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
              New Password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordErrors((prev) => ({ ...prev, password: undefined }));
              }}
              className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              placeholder="••••••••"
            />
            {passwordErrors.password && (
              <p className="mt-1 text-sm text-destructive">
                {passwordErrors.password}
              </p>
            )}
          </div>
          <div>
            <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
              Confirm Password
            </Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setPasswordErrors((prev) => ({
                  ...prev,
                  confirmPassword: undefined,
                }));
              }}
              className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              placeholder="••••••••"
            />
            {passwordErrors.confirmPassword && (
              <p className="mt-1 text-sm text-destructive">
                {passwordErrors.confirmPassword}
              </p>
            )}
          </div>
          <Button
            type="submit"
            disabled={resetMutation.isPending}
            className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] py-3 text-sm font-semibold text-[var(--app-color-foreground)] shadow-[0_18px_32px_-18px_var(--auth-color-primary)] hover:brightness-105"
          >
            {resetMutation.isPending ? "Resetting..." : "Reset Password"}
          </Button>
        </form>
      )}

      <OtpDialog
        isOpen={otpOpen}
        onOpenChange={setOtpOpen}
        email={email}
        onSubmit={handleOtpVerified}
        onResend={() => sendOtpMutation.mutate(email)}
        isLoading={false}
      />
    </GenericAuthPage>
  );
}
