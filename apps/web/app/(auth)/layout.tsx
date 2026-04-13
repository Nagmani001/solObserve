import { authTheme, getAuthThemeVars } from "@/lib/auth-theme";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={getAuthThemeVars(authTheme.defaultColors)}
      className="relative flex min-h-[calc(100vh-3.5rem)] items-center justify-center overflow-hidden px-4"
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,var(--auth-base)_0%,var(--auth-mid)_45%,var(--auth-color-secondary)_76%,var(--auth-color-tertiary)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(110%_55%_at_50%_0%,var(--auth-top-glow)_0%,rgba(255,255,255,0)_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_100%,var(--auth-color-primary)_0%,transparent_100%)] opacity-35" />
      <div className="absolute inset-0 bg-[var(--auth-overlay)]" />
      <div className="absolute inset-0 backdrop-blur-[1px]" />
      <div className="relative z-10 flex w-full items-center justify-center">
        {children}
      </div>
    </div>
  );
}
