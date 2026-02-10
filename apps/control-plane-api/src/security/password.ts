import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const HASH_PREFIX = "scrypt_v1";
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${HASH_PREFIX}:${salt.toString("base64")}:${derivedKey.toString("base64")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [prefix, saltBase64, hashBase64] = storedHash.split(":");
  if (prefix !== HASH_PREFIX || !saltBase64 || !hashBase64) {
    return false;
  }

  const salt = Buffer.from(saltBase64, "base64");
  const expected = Buffer.from(hashBase64, "base64");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}
