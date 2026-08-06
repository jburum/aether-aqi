export type AqiLevel =
  | "good"
  | "moderate"
  | "usg"
  | "unhealthy"
  | "veryUnhealthy"
  | "hazardous";

export interface AqiMeta {
  level: AqiLevel;
  label: string;
  advice: string;
  /** Tailwind-friendly token class suffixes mapped in CSS */
  token: string;
  min: number;
  max: number;
}

export function getAqiMeta(aqi: number | null | undefined): AqiMeta {
  const v = typeof aqi === "number" && Number.isFinite(aqi) ? aqi : -1;
  if (v < 0) {
    return {
      level: "good",
      label: "—",
      advice: "No reading yet.",
      token: "unknown",
      min: 0,
      max: 0,
    };
  }
  if (v <= 50) {
    return {
      level: "good",
      label: "Good",
      advice: "Air quality is satisfactory. Great day for outdoor activity.",
      token: "good",
      min: 0,
      max: 50,
    };
  }
  if (v <= 100) {
    return {
      level: "moderate",
      label: "Moderate",
      advice: "Acceptable overall. Unusually sensitive people should limit prolonged outdoor exertion.",
      token: "moderate",
      min: 51,
      max: 100,
    };
  }
  if (v <= 150) {
    return {
      level: "usg",
      label: "Unhealthy for Sensitive Groups",
      advice: "Sensitive groups should reduce prolonged or heavy outdoor exertion.",
      token: "usg",
      min: 101,
      max: 150,
    };
  }
  if (v <= 200) {
    return {
      level: "unhealthy",
      label: "Unhealthy",
      advice: "Everyone may begin to feel effects. Limit outdoor activity.",
      token: "unhealthy",
      min: 151,
      max: 200,
    };
  }
  if (v <= 300) {
    return {
      level: "veryUnhealthy",
      label: "Very Unhealthy",
      advice: "Health alert: avoid outdoor exertion. Consider masks for PM2.5.",
      token: "very",
      min: 201,
      max: 300,
    };
  }
  return {
    level: "hazardous",
    label: "Hazardous",
    advice: "Emergency conditions. Remain indoors with filtered air if possible.",
    token: "hazardous",
    min: 301,
    max: 500,
  };
}

export function formatAqi(aqi: number | null | undefined): string {
  if (typeof aqi !== "number" || !Number.isFinite(aqi)) return "—";
  return String(Math.round(aqi));
}

/** Solid hex for canvas / MapLibre markers (matches CSS theme tokens). */
export const AQI_HEX: Record<string, string> = {
  good: "#3dba6e",
  moderate: "#d4b106",
  usg: "#e07a1f",
  unhealthy: "#e23d3d",
  very: "#9b5de5",
  hazardous: "#7f1d1d",
  unknown: "#5c6570",
};

export function aqiHex(token: string): string {
  return AQI_HEX[token] ?? AQI_HEX.unknown;
}
