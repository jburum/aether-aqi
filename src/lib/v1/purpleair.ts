import { V1RuleError } from "./errors.ts";

/**
 * PurpleAir spend is not approved. Nothing here calls PurpleAir or buys points.
 * The formula and the outdoor/dropout rules are the week-1 policy, tested on
 * sample rows. `ingestOutdoorSensors` refuses to store them.
 *
 * When a later week parses a PurpleAir payload, location_type 0 is `outdoor`
 * and location_type 1 is `indoor`. This module takes that normalized value.
 */
export interface SensorSample {
  location: "outdoor" | "indoor";
  pmCf1: number | null;
  relativeHumidity: number | null;
}

export type SensorPlan =
  | { action: "fall_back_to_noaa_valley"; officialAqi: null }
  | { action: "purpleair_blocked"; stored: false };

/**
 * Barkjohn et al., Atmos. Meas. Tech., 2021. The US EPA linear correction for
 * PurpleAir cf_1 PM2.5 (µg/m³): 0.524 * pmCf1 - 0.0852 * RH + 5.71.
 * Limited to pmCf1 0..250 and RH 0..100. The later high-smoke extension is a
 * different equation and is not implemented.
 */
export function epaPurpleAirPm25(pmCf1: number, relativeHumidity: number): number {
  if (!Number.isFinite(pmCf1) || pmCf1 < 0 || pmCf1 > 250) {
    throw new V1RuleError(
      "epa_correction_outside_range",
      "The EPA linear correction is applied for PurpleAir cf_1 from 0 to 250 µg/m³.",
    );
  }
  if (!Number.isFinite(relativeHumidity) || relativeHumidity < 0 || relativeHumidity > 100) {
    throw new V1RuleError(
      "epa_correction_outside_range",
      "The EPA linear correction needs relative humidity from 0 to 100.",
    );
  }
  return 0.524 * pmCf1 - 0.0852 * relativeHumidity + 5.71;
}

/** Indoor rows and null PM (a dead sensor) do not count as an outdoor reading. */
export function outdoorReadings(samples: readonly SensorSample[]): SensorSample[] {
  return samples.filter(
    (sample) =>
      sample.location === "outdoor" && sample.pmCf1 != null && Number.isFinite(sample.pmCf1),
  );
}

export function planSensorGap(samples: readonly SensorSample[]): SensorPlan {
  if (outdoorReadings(samples).length > 0) {
    return { action: "purpleair_blocked", stored: false };
  }
  return { action: "fall_back_to_noaa_valley", officialAqi: null };
}

/** Always refuses. Outdoor points are not stored. A dropout does not invent an official number. */
export function ingestOutdoorSensors(samples: readonly SensorSample[]): never {
  const plan = planSensorGap(samples);
  if (plan.action === "fall_back_to_noaa_valley") {
    throw new V1RuleError(
      "sensor_dropout",
      "Outdoor sensors dropped out. Use the NOAA valley forecast. Do not write an official AirNow number.",
    );
  }
  throw new V1RuleError(
    "purpleair_spend_not_approved",
    "PurpleAir is out this week. Spend is not approved, and this path does not buy points or store sensor readings.",
  );
}
