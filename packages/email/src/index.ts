import { Resend } from "resend";
import { createTransport, type Transporter } from "nodemailer";
import sendEmailViaResend from "./sendViaResend";
import sendEmailViaNodemailer from "./sendViaNodemailer";
import { ResendEmailOptions } from "./resend/types";

export interface EmailConfig {
  resendApiKey?: string;
  smtp?: {
    host: string;
    port: number;
    user?: string;
    password?: string;
  };
}

let resend: Resend | null = null;
let transporter: Transporter | null = null;

export function initEmail(config: EmailConfig) {
  resend = null;
  transporter = null;

  if (config.resendApiKey) {
    resend = new Resend(config.resendApiKey);
    return;
  }

  if (config.smtp) {
    transporter = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }
}

export async function sendEmail(options: ResendEmailOptions) {
  if (resend) {
    return await sendEmailViaResend(resend, options);
  }

  if (transporter) {
    return await sendEmailViaNodemailer({
      to: options.to,
      subject: options.subject!,
      react: options.react,
      transporter,
    });
  }

  console.log("errow seding email , neither smpt nor resend is configured");
}

/*
INFO: don't really need this 
export async function sendBatchEmail(options: amy) {
}
*/
