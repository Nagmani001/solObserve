import { betterAuth } from "better-auth";
import { OtpTemplate } from "@repo/email/template/OtpTemplate";
import { emailOTP } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@repo/database/client";
import { sendEmail } from "@repo/email/email";
import { createAuthMiddleware } from "better-auth/api";

const googleEnv =
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_CLIENT_ID.length > 0;

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  /*
INFO: uncomment this in production
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
      domain: ".nagmaniupadhyay.com.np"
    }
  },
   */
  trustedOrigins: [
    "http://localhost:3000",
    "http://web:3000",
    ...(process.env.FRONTEND_URL_DEPLOYED
      ? [process.env.FRONTEND_URL_DEPLOYED.replace(/\/$/, "")]
      : []),
  ],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path != "/sign-up/email") {
        return;
      }
      const body = ctx.body;
      if (!body.email) return;

      const existingUser = await prisma.user.findUnique({
        where: {
          email: body.email,
        },
      });
      if (existingUser && !existingUser.emailVerified) {
        await prisma.account.deleteMany({ where: { userId: existingUser.id } });
        await prisma.session.deleteMany({ where: { userId: existingUser.id } });
        await prisma.user.delete({ where: { id: existingUser.id } });
      }
    }),
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
    ...(googleEnv
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {}),
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ url, email }) => {
        console.log(`[solobserve magic link] ${email} -> ${url}`);
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        if (type === "email-verification" || type === "forget-password") {
          await sendEmail({
            to: email,
            react: OtpTemplate({ otp }),
            subject: "otp vefirication",
          });
        }
      },
    }),
  ],
});
