import { V1RuleError } from "./errors.ts";
import type { Confidence, ForecastSource, Horizon, OfficialBeside, SpatialScale } from "./types.ts";

export interface PushForecast {
  id: string;
  source: ForecastSource;
  correctedAqi: number;
  horizon: Horizon;
  spatialScale: SpatialScale;
  confidence: Confidence;
}

export interface PushPayload {
  kind: "aqi.forecast";
  placeId: string;
  placeName: string;
  title: string;
  body: string;
  issuedAt: string;
  validFor: string;
  forecast: PushForecast;
  official: OfficialBeside | null;
}

export interface PushSendResult {
  ok: true;
  providerId: string;
}

export interface PushFailResult {
  ok: false;
  error: string;
}

/** Delivery sink. Week 1 ships only the in-process test sender (`name: "test"`). */
export interface PushSender {
  readonly name: string;
  send(payload: PushPayload): Promise<PushSendResult | PushFailResult>;
}

const FORECAST_FORBIDDEN = [
  "aqi",
  "officialAqi",
  "officialRaw",
  "raw",
  "attribution",
  "preliminary",
];
const OFFICIAL_FORBIDDEN = ["correctedAqi", "horizon", "confidence", "spatialScale", "forecastAqi"];

export function forecastLabel(source: ForecastSource): string {
  if (source === "noaa_smoke") return "NOAA smoke, valley scale";
  if (source === "noaa_aqf") return "NOAA air quality forecast";
  return "regional, low confidence";
}

export function buildPushPayload(input: {
  placeId: string;
  placeName: string;
  issuedAt: string;
  validFor: string;
  forecast: PushForecast;
  official: OfficialBeside | null;
}): PushPayload {
  const label = forecastLabel(input.forecast.source);
  const official = input.official
    ? {
        id: input.official.id,
        aqi: input.official.aqi,
        raw: input.official.raw,
        preliminary: input.official.preliminary,
        attribution: input.official.attribution,
        source: input.official.source,
        observedAt: input.official.observedAt,
      }
    : null;
  const payload: PushPayload = {
    kind: "aqi.forecast",
    placeId: input.placeId,
    placeName: input.placeName,
    title: `${input.placeName} forecast`,
    body: official
      ? `Corrected forecast ${input.forecast.correctedAqi} (${label}). Official AirNow ${official.aqi}, preliminary. ${official.attribution}`
      : `Corrected forecast ${input.forecast.correctedAqi} (${label}). No official AirNow reading for this hour.`,
    issuedAt: input.issuedAt,
    validFor: input.validFor,
    forecast: {
      id: input.forecast.id,
      source: input.forecast.source,
      correctedAqi: input.forecast.correctedAqi,
      horizon: input.forecast.horizon,
      spatialScale: input.forecast.spatialScale,
      confidence: input.forecast.confidence,
    },
    official,
  };
  assertPayloadSeparated(payload);
  return payload;
}

/** The corrected forecast and the official reading stay on different objects. */
export function assertPayloadSeparated(payload: PushPayload): void {
  const forecastKeys = Object.keys(payload.forecast);
  for (const key of FORECAST_FORBIDDEN) {
    if (forecastKeys.includes(key)) {
      throw new V1RuleError(
        "numbers_mixed",
        "The push forecast object must not carry an official AirNow field.",
      );
    }
  }
  if (typeof payload.forecast.correctedAqi !== "number") {
    throw new V1RuleError("numbers_mixed", "The corrected forecast number is missing.");
  }
  if (!payload.official) return;
  if (payload.official.source !== "airnow" || payload.official.preliminary !== true) {
    throw new V1RuleError(
      "official_not_preliminary",
      "Official AirNow readings in a push payload stay preliminary and credited to AirNow.",
    );
  }
  if (payload.official.raw !== String(payload.official.aqi)) {
    throw new V1RuleError(
      "official_altered",
      "The official number in the push payload does not match its raw token.",
    );
  }
  const officialKeys = Object.keys(payload.official);
  for (const key of OFFICIAL_FORBIDDEN) {
    if (officialKeys.includes(key)) {
      throw new V1RuleError(
        "numbers_mixed",
        "The official AirNow object must not carry the corrected forecast.",
      );
    }
  }
}

/**
 * Records payloads in memory. It does not open a network connection, read a
 * key, or talk to APNs.
 */
export class TestPushSender implements PushSender {
  readonly name = "test" as const;
  readonly sent: PushPayload[] = [];
  failNext = false;

  async send(payload: PushPayload): Promise<PushSendResult | PushFailResult> {
    assertPayloadSeparated(payload);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "test sender refused" };
    }
    this.sent.push(structuredClone(payload));
    return { ok: true, providerId: `test-${this.sent.length}` };
  }
}
