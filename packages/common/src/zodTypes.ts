import { z } from "zod";

export const signupSchema = z.object({
  email: z.email(),
  username: z.string(),
  password: z.string().trim().min(8),
});

export type signupType = z.infer<typeof signupSchema>;

export const signinSchema = z.object({
  email: z.email(),
  password: z.string().trim().min(5).max(30),
});

export type signinType = z.infer<typeof signinSchema>;

export const emailSchema = z.object({
  email: z.email(),
});

export const passwordSchema = z
  .object({
    password: z
      .string()
      .trim()
      .min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
