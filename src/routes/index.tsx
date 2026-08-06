import { createFileRoute } from "@tanstack/react-router";
import { AirQualityApp } from "@/components/aqi-components";
import { AppNav } from "@/components/app-nav";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div className="pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]">
      <AirQualityApp />
      <AppNav />
    </div>
  );
}
