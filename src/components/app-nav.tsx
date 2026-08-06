import { Link, useRouterState } from "@tanstack/react-router";
import { List, Map as MapIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { to: "/", label: "List", icon: List, match: (p: string) => p === "/" },
  { to: "/map", label: "Map", icon: MapIcon, match: (p: string) => p.startsWith("/map") },
] as const;

/** Bottom tab bar — List ↔ Map (Phase A). */
export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      className="aqi-nav fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 backdrop-blur-md"
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-5xl items-stretch justify-around px-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] pt-1">
        {items.map(({ to, label, icon: Icon, match }) => {
          const isActive = match(pathname);
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex min-w-[4.5rem] flex-col items-center gap-0.5 rounded-lg px-4 py-2 text-xs font-medium transition-colors",
                isActive ? "text-fg" : "text-muted hover:text-fg",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon
                className={cn("size-5", isActive ? "text-fg" : "text-subtle")}
                strokeWidth={isActive ? 2.25 : 2}
                aria-hidden
              />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
