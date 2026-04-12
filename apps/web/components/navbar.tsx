import { ThemeToggle } from "@/components/theme-toggle";

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center px-4 md:px-8">
        <div className="flex flex-1 items-center gap-2">
          <span className="text-lg font-bold tracking-tight">Template</span>
        </div>
        <nav className="flex items-center gap-1">
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
