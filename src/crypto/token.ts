/**
 * AES-256-GCM encryption for GitHub access tokens at rest.
 *
 * Wire format (docs/database.md): `v{keyVersion}:{iv}:{ciphertext}:{authTag}`
 * where iv / ciphertext / authTag are base64url. A random 12-byte IV is used
 * per encryption so identical tokens never produce identical rows.
 *
 * The encryption key stays in env (`TOKEN_ENCRYPTION_KEY`); only the version
 * label is stored beside the ciphertext so rotation can re-encrypt lazily.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class TokenCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenCryptoError';
  }
}

export interface EncryptOptions {
  keyHex: string;
  keyVersion: string;
}

export interface DecryptOptions {
  keyHex: string;
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY must be 32 bytes hex');
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a GitHub token. Plaintext exists only in caller memory for this call.
 */
export function encryptToken(plaintext: string, options: EncryptOptions): string {
  if (!plaintext) {
    throw new TokenCryptoError('refusing to encrypt empty token');
  }
  if (!options.keyVersion) {
    throw new TokenCryptoError('keyVersion is required');
  }

  const key = parseKey(options.keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    `v${options.keyVersion}`,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a sealed token payload. Throws TokenCryptoError on format errors,
 * wrong key, or authentication-tag failure (tamper detection).
 */
export function decryptToken(payload: string, options: DecryptOptions): string {
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new TokenCryptoError('invalid token payload format');
  }

  const [versionPart, ivB64, cipherB64, tagB64] = parts;
  if (!versionPart?.startsWith('v') || versionPart.length < 2) {
    throw new TokenCryptoError('invalid token key version prefix');
  }
  if (!ivB64 || !cipherB64 || !tagB64) {
    throw new TokenCryptoError('invalid token payload parts');
  }

  try {
    const key = parseKey(options.keyHex);
    const iv = Buffer.from(ivB64, 'base64url');
    const ciphertext = Buffer.from(cipherB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');

    if (iv.length !== IV_LENGTH) {
      throw new TokenCryptoError('invalid IV length');
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new TokenCryptoError('invalid auth tag length');
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    if (err instanceof TokenCryptoError) throw err;
    throw new TokenCryptoError('token decryption failed', { cause: err });
  }
}

export function tokenKeyVersionFromPayload(payload: string): string {
  const versionPart = payload.split(':')[0];
  if (!versionPart?.startsWith('v') || versionPart.length < 2) {
    throw new TokenCryptoError('invalid token key version prefix');
  }
  return versionPart.slice(1);
}
