import React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Tailwind,
  render,
} from "@react-email/components";

interface OtpTemplateProps {
  otp: string;
}

export const OtpTemplate = ({ otp }: OtpTemplateProps) => {
  return (
    <Html>
      <Head />
      <Preview>Your OTP Code for Codeforces</Preview>
      <Tailwind>
        <Body className="bg-[#f6f9fc] font-sans">
          <Container className="bg-[#ffffff] mx-auto mb-16 p-5 pb-12 rounded-lg shadow-sm max-w-[600px] mt-10">
            <Heading className="text-white text-2xl font-semibold leading-10 m-0 bg-black p-6 text-center rounded-t-lg">
              Codeforces
            </Heading>
            <Section className="p-10 px-8 text-center">
              <Text className="text-[#333333] text-base leading-6 mb-6 text-left">
                Hello,
              </Text>
              <Text className="text-[#333333] text-base leading-6 mb-6 text-left">
                You requested a one-time password (OTP) for your Codeforces
                account. Please use the following code to complete your
                verification:
              </Text>
              <Section className="bg-[#f0f4f8] rounded-lg p-2 inline-block mb-6 min-w-[200px]">
                <Text className="font-mono text-3xl font-bold text-[#2d3748] tracking-[6px] m-0 text-center">
                  {otp}
                </Text>
              </Section>
              <Text className="text-[#333333] text-base leading-6 mb-6 text-left">
                This code will expire in 10 minutes. If you did not request this
                code, please ignore this email.
              </Text>
            </Section>
            <Section className="text-[#718096] text-xs text-center mt-6 border-t border-[#edf2f7] pt-6">
              <Text className="my-2">
                &copy; {new Date().getFullYear()} Codeforces. All rights
                reserved.
              </Text>
              <Text className="my-2">
                This is an automated message, please do not reply.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export const renderOtpTemplate = (otp: string) =>
  render(<OtpTemplate otp={otp} />);

export default OtpTemplate;
