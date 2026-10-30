import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import { buildPushPayload, type PushPayload } from "./push.ts";

/** Fixed clock for the sample payloads. Day boundaries are lead hours from this instant. */
export const SAMPLE_ISSUED_AT = "2026-10-30T15:00:00.000Z";
export const SAMPLE_VALID_DAY1 = "2026-10-31T15:00:00.000Z";
export const SAMPLE_VALID_DAY5 = "2026-11-03T15:00:00.000Z";
export const SAMPLE_VALID_DAY6 = "2026-11-04T15:00:00.000Z";

export const SAMPLE_PLACE = {
  name: "Boise, Idaho",
  latitude: 43.615,
  longitude: -116.202,
  valley: "Treasure Valley",
  alertAt: 100,
} as const;

export const SAMPLE_FORECAST_DAY1 = {
  source: "noaa_smoke",
  issuedAt: SAMPLE_ISSUED_AT,
  validFor: SAMPLE_VALID_DAY1,
  horizon: "day_1_2_valley",
  spatialScale: "valley",
  confidence: "valley",
  correctedAqi: 155,
} as const;

export const SAMPLE_FORECAST_DAY5 = {
  source: "noaa_aqf",
  issuedAt: SAMPLE_ISSUED_AT,
  validFor: SAMPLE_VALID_DAY5,
  horizon: "day_3_7_noaa_aqf",
  spatialScale: "regional",
  confidence: "model",
  correctedAqi: 90,
} as const;

export const SAMPLE_FORECAST_DAY6 = {
  source: "regional",
  issuedAt: SAMPLE_ISSUED_AT,
  validFor: SAMPLE_VALID_DAY6,
  horizon: "day_3_7_regional_low_confidence",
  spatialScale: "regional",
  confidence: "low",
  correctedAqi: 80,
} as const;

export const SAMPLE_OFFICIAL = {
  observedAt: SAMPLE_VALID_DAY1,
  officialAqi: 48,
  officialRaw: "48",
  source: "airnow",
  preliminary: true,
  attribution: AIRNOW_ATTRIBUTION,
} as const;

const DAY1_OFFICIAL = {
  id: "obs_boise_day1",
  aqi: SAMPLE_OFFICIAL.officialAqi,
  raw: SAMPLE_OFFICIAL.officialRaw,
  preliminary: true as const,
  attribution: AIRNOW_ATTRIBUTION,
  source: "airnow" as const,
  observedAt: SAMPLE_VALID_DAY1,
};

/** Example envelopes the test sender can emit. Live deliveries use database ids. */
export function samplePushPayloads(): PushPayload[] {
  return [
    buildPushPayload({
      placeId: "place_boise",
      placeName: SAMPLE_PLACE.name,
      issuedAt: SAMPLE_ISSUED_AT,
      validFor: SAMPLE_VALID_DAY1,
      forecast: {
        id: "forecast_boise_day1",
        source: SAMPLE_FORECAST_DAY1.source,
        correctedAqi: SAMPLE_FORECAST_DAY1.correctedAqi,
        horizon: SAMPLE_FORECAST_DAY1.horizon,
        spatialScale: SAMPLE_FORECAST_DAY1.spatialScale,
        confidence: SAMPLE_FORECAST_DAY1.confidence,
      },
      official: DAY1_OFFICIAL,
    }),
    buildPushPayload({
      placeId: "place_boise",
      placeName: SAMPLE_PLACE.name,
      issuedAt: SAMPLE_ISSUED_AT,
      validFor: SAMPLE_VALID_DAY5,
      forecast: {
        id: "forecast_boise_day5",
        source: SAMPLE_FORECAST_DAY5.source,
        correctedAqi: SAMPLE_FORECAST_DAY5.correctedAqi,
        horizon: SAMPLE_FORECAST_DAY5.horizon,
        spatialScale: SAMPLE_FORECAST_DAY5.spatialScale,
        confidence: SAMPLE_FORECAST_DAY5.confidence,
      },
      official: null,
    }),
    buildPushPayload({
      placeId: "place_boise",
      placeName: SAMPLE_PLACE.name,
      issuedAt: SAMPLE_ISSUED_AT,
      validFor: SAMPLE_VALID_DAY6,
      forecast: {
        id: "forecast_boise_day6",
        source: SAMPLE_FORECAST_DAY6.source,
        correctedAqi: SAMPLE_FORECAST_DAY6.correctedAqi,
        horizon: SAMPLE_FORECAST_DAY6.horizon,
        spatialScale: SAMPLE_FORECAST_DAY6.spatialScale,
        confidence: SAMPLE_FORECAST_DAY6.confidence,
      },
      official: null,
    }),
  ];
}
