"use client";

import { useState } from "react";
import { signinSchema, signinType } from "@repo/common/zodTypes";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth";
import { toast } from "@repo/ui/lib/toast";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OnboardShell, withStatus } from "@/components/onboard-shell";
import {
  Divider,
  FieldError,
  FieldInput,
  FieldLabel,
  PrimaryButton,
} from "@/components/onboard-form";
import { SocialAuthButtons } from "@/components/social-auth-buttons";
import { MagicLinkBlock } from "./magic-link-block";

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
        router.push("/orgs");
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <OnboardShell
      steps={withStatus(1)}
      eyebrow="Step 01 of 04"
      title="Sign in"
      description="Pick up where you left off. Magic link, password, or OAuth."
      footer={
        <span>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium hover:opacity-80"
            style={{ color: "var(--accent)" }}
          >
            Sign up
          </Link>
        </span>
      }
    >
      <SocialAuthButtons />

      <Divider label="or" />

      <MagicLinkBlock />

      <Divider label="password" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = signinSchema.safeParse({ email, password });
          if (!parsed.success) {
            const fe = parsed.error.flatten().fieldErrors;
            setErrors({ email: fe.email?.[0], password: fe.password?.[0] });
            return;
          }
          setErrors({});
          mutation.mutate({ email, password });
        }}
        className="space-y-4"
      >
        <div>
          <FieldLabel htmlFor="signin-email">Email</FieldLabel>
          <FieldInput
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((p) => ({ ...p, email: undefined }));
            }}
            placeholder="you@example.com"
            autoComplete="email"
          />
          <FieldError>{errors.email}</FieldError>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <FieldLabel htmlFor="signin-password">Password</FieldLabel>
            <Link
              href="/forgot-password"
              className="text-[11px] hover:opacity-80"
              style={{ color: "var(--ink-mid)" }}
            >
              Forgot?
            </Link>
          </div>
          <FieldInput
            id="signin-password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrors((p) => ({ ...p, password: undefined }));
            }}
            placeholder="••••••••"
            autoComplete="current-password"
          />
          <FieldError>{errors.password}</FieldError>
        </div>
        <div className="pt-2">
          <PrimaryButton
            type="submit"
            disabled={mutation.isPending}
            className="w-full"
          >
            {mutation.isPending ? "Signing in…" : "Sign in"}
          </PrimaryButton>
        </div>
      </form>
    </OnboardShell>
  );
}
