"use client";

import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { signinSchema, signinType } from "@repo/common/zodTypes";
import { Label } from "@repo/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GenericAuthPage } from "@/components/generic-auth-page";
import { SocialAuthButtons } from "@/components/social-auth-buttons";

export default function Page() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const router = useRouter();

  const mutation = useMutation({
    mutationFn: async (signinInputs: signinType) => {
      const res = await authClient.signIn.email({
        email: signinInputs.email,
        password: signinInputs.password,
      });
      if (res.error) {
        toast.error(res.error.message);
      } else {
        router.push("/dashboard");
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <GenericAuthPage
      title="Welcome back"
      subtitle="Sign in to your account"
      footerLabel="Don't have an account?"
      footerHref="/signup"
      footerHrefLabel="Sign up"
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

          const parsed = signinSchema.safeParse({
            email,
            password,
          });

          if (!parsed.success) {
            const fieldErrors = parsed.error.flatten().fieldErrors;
            setErrors({
              email: fieldErrors.email?.[0],
              password: fieldErrors.password?.[0],
            });
            return;
          }

          setErrors({});
          mutation.mutate({
            email,
            password,
          });
        }}
        className="space-y-4"
      >
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
          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-xs text-[var(--auth-color-primary)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </div>
        <Button
          type="submit"
          className="h-auto w-full rounded-xl border border-[var(--auth-border)] bg-[var(--auth-color-primary)] py-3 text-sm font-semibold text-[var(--app-color-foreground)] shadow-[0_18px_32px_-18px_var(--auth-color-primary)] hover:brightness-105"
        >
          Sign In
        </Button>
      </form>
    </GenericAuthPage>
  );
}
