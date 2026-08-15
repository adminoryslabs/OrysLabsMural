import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters. 19 MiB / 2 passes is the OWASP baseline; comfortable for
 * a classroom-sized deployment on a small VPS.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Never throws: a malformed or truncated stored hash means "not authenticated",
 * not a 500.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
