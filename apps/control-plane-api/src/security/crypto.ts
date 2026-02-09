import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config.js";

const key = Buffer.from(env.ENCRYPTION_KEY, "hex");

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(cipherText: string): string {
  const [version, ivBase64, tagBase64, payloadBase64] = cipherText.split(":");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !payloadBase64) {
    throw new Error("invalid_encrypted_secret_format");
  }

  const iv = Buffer.from(ivBase64, "base64");
  const tag = Buffer.from(tagBase64, "base64");
  const payload = Buffer.from(payloadBase64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString("utf8");
}
