import crypto from "crypto";

const algorithm = "aes-256-gcm";

export function encrypt(text: string, secret: string): string {
  // Hash the secret to ensure it's 32 bytes
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(algorithm, key, iv);

  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");

  const tag = cipher.getAuthTag();

  // Format: iv:authTag:encryptedData
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted}`;
}

export function decrypt(encryptedText: string, secret: string): string {
  const key = crypto.createHash("sha256").update(secret).digest();
  const [ivStr, tagStr, encrypted] = encryptedText.split(":");

  if (!ivStr || !tagStr || !encrypted)
    throw new Error("Invalid encrypted format");

  const iv = Buffer.from(ivStr, "base64");
  const tag = Buffer.from(tagStr, "base64");

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
