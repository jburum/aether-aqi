import { createFileRoute } from "@tanstack/react-router";
import { AppNav } from "@/components/app-nav";
import { WatchlistMap } from "@/components/watchlist-map";

export const Route = createFileRoute("/map")({ component: MapPage });

function MapPage() {
  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-bg">
      <WatchlistMap />
      <AppNav />
    </div>
  );
}
