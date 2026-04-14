import { render, pretty } from "@react-email/render";
import { NodemailerInput } from "./resend/types";

export default async function sendEmailViaNodemailer({
  to,
  subject,
  react,
  transporter,
}: NodemailerInput) {
  return await transporter.sendMail({
    from: "noreply@example.com",
    to,
    subject,
    html: await pretty(await render(react)),
  });
}
