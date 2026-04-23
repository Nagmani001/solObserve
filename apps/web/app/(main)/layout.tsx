import { ensureAppUser } from "@/lib/rbac";

export default async function MainGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await ensureAppUser();

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 md:px-8">
      {children}
    </div>
  );
}
