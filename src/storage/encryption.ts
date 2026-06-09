import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { ENV } from "../config/env.js";

const V2_PREFIX = "smcp:v2:scrypt";
const RAW_KEY_PREFIX = "base64url:";
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = {
  cost: 32768,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
};

async function importA256GcmKey(key: Uint8Array) {
  return importJWK({ kty: "oct", k: Buffer.from(key).toString("base64url") }, "dir");
}

function decodeRawKey(secretKey: string): Uint8Array | null {
  if (!secretKey.startsWith(RAW_KEY_PREFIX)) return null;
  const raw = Buffer.from(secretKey.slice(RAW_KEY_PREFIX.length), "base64url");
  if (raw.length !== SCRYPT_KEY_LENGTH) {
    throw new Error("MCP_ENCRYPTION_KEY base64url raw key must decode to exactly 32 bytes.");
  }
  return raw;
}

/**
 * Dịch vụ mã hóa cấu hình (EncryptionService).
 * Tự động mã hóa/giải mã toàn bộ Blob dữ liệu nếu có MCP_ENCRYPTION_KEY.
 * Đảm bảo an toàn (Data at Rest) dù lưu ở Local FS hay Redis.
 */
export class EncryptionService {
  private readonly secretKey?: string;
  private readonly rawKey: Uint8Array | null = null;

  constructor(secretKey?: string) {
    this.secretKey = secretKey;
    this.rawKey = secretKey ? decodeRawKey(secretKey) : null;
  }

  private deriveV2Key(salt: Uint8Array): Uint8Array {
    if (!this.secretKey) {
      throw new Error("MCP_ENCRYPTION_KEY is required for encrypted state.");
    }
    return this.rawKey || scryptSync(this.secretKey, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  }

  private deriveLegacyKey(): Uint8Array {
    if (!this.secretKey) {
      throw new Error("MCP_ENCRYPTION_KEY is required for encrypted state.");
    }
    return createHash("sha256").update(this.secretKey).digest();
  }

  async encryptState(state: Record<string, unknown>): Promise<string> {
    const payload = JSON.stringify(state);
    if (!this.secretKey) {
      return payload; // Nếu không cài key, lưu plain-text
    }

    const salt = randomBytes(16);
    const key = this.deriveV2Key(salt);
    const secret = await importA256GcmKey(key);
    const jwe = await new CompactEncrypt(new TextEncoder().encode(payload))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .encrypt(secret);
    return `${V2_PREFIX}:${Buffer.from(salt).toString("base64url")}:${jwe}`;
  }

  async decryptState(data: string): Promise<Record<string, unknown>> {
    if (!this.secretKey) {
      return JSON.parse(data);
    }

    if (data.startsWith(`${V2_PREFIX}:`)) {
      const parts = data.split(":");
      if (parts.length !== 5) {
        throw new Error("Invalid encrypted state envelope.");
      }
      try {
        const salt = Buffer.from(parts[3], "base64url");
        const jwe = parts[4];
        const secret = await importA256GcmKey(this.deriveV2Key(salt));
        const { plaintext } = await compactDecrypt(jwe, secret);
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        throw new Error("Failed to decrypt encrypted state.");
      }
    }

    if (!ENV.MCP_ALLOW_LEGACY_SHA256_KDF) {
      throw new Error("Legacy SHA-256 encrypted state detected. Set MCP_ALLOW_LEGACY_SHA256_KDF=true for one migration run.");
    }

    try {
      const secret = await importA256GcmKey(this.deriveLegacyKey());
      const { plaintext } = await compactDecrypt(data, secret);
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new Error("Failed to decrypt legacy encrypted state.");
    }
  }
}

export const globalEncryption = new EncryptionService(ENV.MCP_ENCRYPTION_KEY);
