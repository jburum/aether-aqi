import { createFileRoute } from "@tanstack/react-router";
import { AirQualityApp } from "@/components/aqi-components";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <AirQualityApp />;
}
