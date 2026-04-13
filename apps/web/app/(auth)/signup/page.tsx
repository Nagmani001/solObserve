"use client";

import { useState } from "react";
import { signupSchema } from "@repo/common/zodTypes";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import { useRouter } from "next/navigation";
import { OtpDialog } from "@/components/otp-dialogue";
import { GenericAuthPage } from "@/components/generic-auth-page";
import { SocialAuthButtons } from "@/components/social-auth-buttons";

interface SignupInputs {
  name: string;
  email: string;
  password: string;
}
export default function Page() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otpOpen, setOtpOpen] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
  }>({});
  const router = useRouter();

  const mutation = useMutation({
    mutationFn: async (signupInputs: SignupInputs) => {
      const res = await authClient.signUp.email({
        email: signupInputs.email,
        name: signupInputs.name,
        password: signupInputs.password,
      });
      if (res.error) {
        const isAlreadyRegistered =
          res.error.code === "USER_ALREADY_EXISTS" ||
          (res.error.message ?? "").toLowerCase().includes("already exists");

        if (isAlreadyRegistered) {
          toast.error(
            "An account with this email already exists. Please sign in.",
          );
          router.push("/signin");
          return;
        }

        toast.error(res.error.message);
      } else {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email: signupInputs.email,
          type: "email-verification",
        });
        if (error) {
          toast.error(error.message);
        } else {
          setEmail(signupInputs.email);
          toast.success("Verification code sent to your email");
          setOtpOpen(true);
        }
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (otp: string) => {
      const res = await authClient.emailOtp.verifyEmail({
        email,
        otp,
      });
      if (res.error) {
        toast.error(res.error.message);
      } else {
        toast.success("Email verified successfully!");
        setOtpOpen(false);
        router.push("/signin");
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  async function handleResendOtp() {
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    });
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Verification code resent");
    }
  }

  return (
    <GenericAuthPage
      title="Create your account"
      subtitle="Create your account to get started"
      footerLabel="Already have an account?"
      footerHref="/signin"
      footerHrefLabel="Sign in"
    >
      <SocialAuthButtons />

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--auth-border)]" />
        <span className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--auth-text-muted)]">
          or continue with email
        </span>
        <div className="h-px flex-1 bg-[var(--auth-border)]" />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();

          const parsed = signupSchema.safeParse({
            username: name,
            email,
            password,
          });

          if (!parsed.success) {
            const fieldErrors = parsed.error.flatten().fieldErrors;
            setErrors({
              name: fieldErrors.username?.[0],
              email: fieldErrors.email?.[0],
              password: fieldErrors.password?.[0],
            });
            return;
          }

          setErrors({});
          mutation.mutate({
            name,
            email,
            password,
          });
        }}
        className="space-y-4"
      >
        <div>
          <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
            Full Name
          </Label>
          <Input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((prev) => ({ ...prev, name: undefined }));
            }}
            className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            placeholder="John Doe"
          />
          {errors.name && (
            <p className="mt-1 text-sm text-destructive">{errors.name}</p>
          )}
        </div>
        <div>
          <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
            Email
          </Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((prev) => ({ ...prev, email: undefined }));
            }}
            className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            placeholder="you@example.com"
          />
          {errors.email && (
            <p className="mt-1 text-sm text-destructive">{errors.email}</p>
          )}
        </div>
        <div>
          <Label className="mb-1.5 text-sm text-[var(--auth-text-muted)]">
            Password
          </Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrors((prev) => ({ ...prev, password: undefined }));
            }}
            className="h-auto w-full rounded-xl border-[var(--auth-border)] bg-[var(--auth-surface-strong)] px-4 py-3 text-sm text-[var(--auth-text)] placeholder:text-[var(--auth-text-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            placeholder="••••••••"
          />
          {errors.password && (
            <p className="mt-1 text-sm text-destructive">{errors.password}</p>
          )}
        </div>
        <Button
          type="submit"
          className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] py-3 text-sm font-semibold text-[var(--app-color-foreground)] shadow-[0_18px_32px_-18px_var(--auth-color-primary)] hover:brightness-105"
        >
          Create Account
        </Button>
      </form>

      <OtpDialog
        isOpen={otpOpen}
        onOpenChange={setOtpOpen}
        email={email}
        onSubmit={(otp) => verifyMutation.mutate(otp)}
        onResend={handleResendOtp}
        isLoading={verifyMutation.isPending}
      />
    </GenericAuthPage>
  );
}
