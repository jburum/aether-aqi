/** Rule the week-1 store refused. `code` is the stable API token. */
export class V1RuleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "V1RuleError";
    this.code = code;
    this.status = status;
  }
}

/** A Pro-only read or a saved place past the free slot. Status is 403, never 500. */
export type EntitlementFeature = "alerts" | "saved_places";

export class NotEntitledError extends V1RuleError {
  readonly feature: EntitlementFeature;
  readonly tier = "free" as const;

  constructor(feature: EntitlementFeature, message: string) {
    super("not_entitled", message, 403);
    this.name = "NotEntitledError";
    this.feature = feature;
  }
}
