"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OtpDialog } from "@/components/otp-dialogue";
import { emailSchema, passwordSchema } from "@repo/common/zodTypes";
import { OnboardShell, withStatus } from "@/components/onboard-shell";
import {
  FieldError,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";

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
    <OnboardShell
      steps={withStatus(1)}
      eyebrow={step === "email" ? "Recover access" : "Set new password"}
      title={step === "email" ? "Reset password" : "Pick a new password"}
      description={
        step === "email"
          ? "We will send a six-digit code to your email."
          : "Choose something stronger than the last one."
      }
      footer={
        <span>
          Remember it?{" "}
          <Link
            href="/signin"
            className="font-medium hover:opacity-80"
            style={{ color: "var(--accent)" }}
          >
            Back to sign in
          </Link>
        </span>
      }
    >
      {step === "email" ? (
        <form onSubmit={handleEmailSubmit} className="space-y-5">
          <div>
            <FieldLabel htmlFor="fp-email">Email</FieldLabel>
            <FieldInput
              id="fp-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(undefined);
              }}
              placeholder="you@example.com"
              autoComplete="email"
            />
            <FieldError>{emailError}</FieldError>
          </div>
          <PrimaryButton
            type="submit"
            disabled={sendOtpMutation.isPending}
            className="w-full"
          >
            {sendOtpMutation.isPending ? "Sending…" : "Send code"}
          </PrimaryButton>
        </form>
      ) : (
        <form onSubmit={handleResetSubmit} className="space-y-5">
          <div>
            <FieldLabel htmlFor="fp-pw">New password</FieldLabel>
            <FieldInput
              id="fp-pw"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordErrors((p) => ({ ...p, password: undefined }));
              }}
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <FieldError>{passwordErrors.password}</FieldError>
          </div>
          <div>
            <FieldLabel htmlFor="fp-pw2">Confirm</FieldLabel>
            <FieldInput
              id="fp-pw2"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setPasswordErrors((p) => ({
                  ...p,
                  confirmPassword: undefined,
                }));
              }}
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <FieldError>{passwordErrors.confirmPassword}</FieldError>
          </div>
          <PrimaryButton
            type="submit"
            disabled={resetMutation.isPending}
            className="w-full"
          >
            {resetMutation.isPending ? "Resetting…" : "Reset password"}
          </PrimaryButton>
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
    </OnboardShell>
  );
}
