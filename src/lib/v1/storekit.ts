import { V1RuleError } from "./errors.ts";
import { parseUtcInstant } from "./phase2.ts";

/**
 * StoreKit 2 verification for a signed transaction.
 * This slice does not call Apple, does not read the environment, and does not
 * hold an App Store Connect key. A later verifier can check Apple's certificate
 * chain locally. The HTTP route does not verify; it only reads the stored row.
 */
export interface StoreKitVerifier {
  verify(signedTransaction: string, now: Date): VerifiedTransaction;
}

export const PRO_PRODUCTS = ["monthly", "yearly"] as const;
export type ProProduct = (typeof PRO_PRODUCTS)[number];

export const STORED_STATES = ["active", "grace", "expired", "revoked"] as const;
export type StoredEntitlementState = (typeof STORED_STATES)[number];

export interface VerifiedTransaction {
  product: ProProduct;
  expiresAt: string;
  state: StoredEntitlementState;
  source: "storekit";
}

export interface FixtureTransaction {
  productId: ProProduct;
  expiresAt: string;
  /** Set when Apple has revoked the transaction. Revocation wins over grace. */
  revokedAt?: string | null;
  /** Billing retry. Still Pro after expiresAt until a later transaction says otherwise. */
  inGracePeriod?: boolean;
  originalTransactionId: string;
}

const FIXTURE_ALG = "fixture";

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new V1RuleError("storekit_invalid", "Signed transaction could not be read.", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Test double. The compact form is three segments, like a StoreKit 2 JWS,
 * but the algorithm is `fixture` and the signature is the word fixture.
 * It does not contact Apple.
 */
export function fixtureSignedTransaction(body: FixtureTransaction): string {
  const header = encodeSegment({ alg: FIXTURE_ALG, typ: "StoreKit2Transaction" });
  const payload = encodeSegment(body);
  const signature = encodeSegment("fixture");
  return `${header}.${payload}.${signature}`;
}

function requireProduct(value: unknown): ProProduct {
  if (value !== "monthly" && value !== "yearly") {
    throw new V1RuleError(
      "storekit_invalid",
      "Product must be monthly ($1.99) or yearly ($12.99).",
      400,
    );
  }
  return value;
}

function decideState(
  revokedAt: string | null,
  inGracePeriod: boolean,
  expiresAt: string,
  now: Date,
): StoredEntitlementState {
  if (revokedAt != null) return "revoked";
  if (inGracePeriod) return "grace";
  if (Date.parse(expiresAt) <= now.getTime()) return "expired";
  return "active";
}

export class FixtureStoreKitVerifier implements StoreKitVerifier {
  verify(signedTransaction: string, now: Date): VerifiedTransaction {
    const parts = signedTransaction.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new V1RuleError("storekit_invalid", "Signed transaction could not be read.", 400);
    }
    const header = decodeSegment(parts[0] ?? "");
    const payload = decodeSegment(parts[1] ?? "");
    const signature = decodeSegment(parts[2] ?? "");
    if (!isRecord(header) || header.alg !== FIXTURE_ALG || signature !== "fixture") {
      throw new V1RuleError("storekit_invalid", "Signed transaction could not be verified.", 400);
    }
    if (!isRecord(payload)) {
      throw new V1RuleError("storekit_invalid", "Signed transaction could not be read.", 400);
    }
    const product = requireProduct(payload.productId);
    if (typeof payload.expiresAt !== "string") {
      throw new V1RuleError("storekit_invalid", "Signed transaction is missing expiresAt.", 400);
    }
    const expiresAt = parseUtcInstant(payload.expiresAt, "expiresAt");
    let revokedAt: string | null = null;
    if (payload.revokedAt != null) {
      if (typeof payload.revokedAt !== "string") {
        throw new V1RuleError("storekit_invalid", "revokedAt must be a UTC timestamp.", 400);
      }
      revokedAt = parseUtcInstant(payload.revokedAt, "revokedAt");
    }
    if (payload.inGracePeriod != null && typeof payload.inGracePeriod !== "boolean") {
      throw new V1RuleError("storekit_invalid", "inGracePeriod must be a boolean.", 400);
    }
    if (
      typeof payload.originalTransactionId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,80}$/.test(payload.originalTransactionId)
    ) {
      throw new V1RuleError(
        "storekit_invalid",
        "originalTransactionId must be a short transaction id.",
        400,
      );
    }
    return {
      product,
      expiresAt,
      state: decideState(revokedAt, payload.inGracePeriod === true, expiresAt, now),
      source: "storekit",
    };
  }
}

/**
 * Fail closed. Wired nowhere on the request path. It refuses every payload,
 * including the fixture form, and it does not open a socket.
 */
export const unavailableStoreKitVerifier: StoreKitVerifier = {
  verify(_signedTransaction: string, _now: Date): VerifiedTransaction {
    throw new V1RuleError(
      "storekit_unavailable",
      "StoreKit verification is not configured. This server does not call Apple and does not hold an App Store Connect key.",
      403,
    );
  },
};
