import { Resend } from "resend";
import { dirname } from "path";
import { fileURLToPath } from "url";
import path from "path";
import { config } from "dotenv";
import sendEmailViaResend from "./sendViaResend";
import sendEmailViaNodemailer from "./sendViaNodemailer";
import { ResendEmailOptions } from "./resend/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({
  path: `${path.join(__dirname, "..")}/.env`,
});

export const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export async function sendEmail(options: ResendEmailOptions) {
  if (resend) {
    return await sendEmailViaResend(options);
  }

  const smptConfigured = Boolean(
    process.env.SMTP_PORT && process.env.SMTP_HOST,
  );

  if (smptConfigured) {
    return await sendEmailViaNodemailer({
      to: options.to,
      subject: options.subject!,
      react: options.react,
    });
  }
  console.log("errow seding email , neither smpt nor resend is configured");
}

/*
INFO: don't really need this 
export async function sendBatchEmail(options: amy) {
}
*/
