export type BoundErrorConstructor = new (message: string) => Error;

export function assertPositiveSafeInteger(
  value: number,
  name: string,
  ErrorCtor: BoundErrorConstructor = RangeError
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ErrorCtor(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function assertNonNegativeSafeInteger(
  value: number,
  name: string,
  ErrorCtor: BoundErrorConstructor = RangeError
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ErrorCtor(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

export function assertSafeIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
  ErrorCtor: BoundErrorConstructor = RangeError
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ErrorCtor(`${name} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
