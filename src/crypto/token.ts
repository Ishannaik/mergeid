/**
 * Versioned authenticated encryption for stored third-party tokens.
 *
 * Ciphertext travels as a self-describing envelope —
 * `v{version}:{iv}:{ciphertext}:{authTag}`, every binary field in canonical
 * unpadded base64url — so key rotation is a configuration change: the active
 * key encrypts, while every configured legacy key still opens the envelopes it
 * produced.
 *
 * The version prefix is bound into the ciphertext as AES-256-GCM additional
 * authenticated data, so relabelling an envelope to another version fails
 * authentication even when both versions share key material.
 *
 * Every failure is value-free: no message carries a key, a plaintext, a
 * ciphertext, or any part of the supplied envelope, so an error can be logged
 * verbatim without leaking the material it was protecting.
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** One configured key: a positive version and 32 bytes of hex-encoded secret. */
export type TokenEncryptionKey = Readonly<{
  version: number;
  key: string;
}>;

/**
 * Key material for a {@link TokenCrypto}.
 *
 * `active` encrypts and decrypts; `legacy` keys only decrypt, keeping stored
 * envelopes readable until they are re-encrypted. Versions must be unique
 * across both.
 */
export type TokenCryptoOptions = Readonly<{
  active: TokenEncryptionKey;
  legacy?: readonly TokenEncryptionKey[];
}>;

/** Envelope encryption bound to one set of keys. */
export type TokenCrypto = Readonly<{
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}>;

/** Raised for rejected key configuration and for any envelope that fails to open. */
export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** 32 bytes of key material, hex encoded. */
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Canonical version spelling: no sign, no leading zero, no exponent. */
const VERSION_PREFIX_PATTERN = /^v[1-9][0-9]*$/;

const MALFORMED = 'Token envelope is malformed.';
const UNKNOWN_VERSION = 'Token envelope uses an unknown key version.';
const UNDECRYPTABLE = 'Token envelope could not be decrypted.';

/** A decoded key, with the wire prefix and its AAD derived once. */
type VersionedKey = Readonly<{
  prefix: string;
  aad: Buffer;
  key: Buffer;
}>;

/**
 * Validates one configured key and registers it under its wire prefix.
 *
 * Registering by prefix rather than by number is what makes the stored `aad`
 * byte-identical to the prefix a decrypted envelope must present: an envelope
 * only reaches a key by matching that exact string.
 *
 * @throws {TokenCryptoError} naming only `role` and the violated rule — never
 *   the rejected value.
 */
function registerKey(
  keys: Map<string, VersionedKey>,
  { version, key }: TokenEncryptionKey,
  role: 'Active' | 'Legacy',
): VersionedKey {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TokenCryptoError(`${role} token key version must be a positive safe integer.`);
  }

  if (!KEY_PATTERN.test(key)) {
    throw new TokenCryptoError(`${role} token key must be 64 hexadecimal characters.`);
  }

  const prefix = `v${version}`;

  if (keys.has(prefix)) {
    throw new TokenCryptoError('Token key versions must be unique across active and legacy keys.');
  }

  const registered: VersionedKey = {
    prefix,
    aad: Buffer.from(prefix, 'utf8'),
    key: Buffer.from(key, 'hex'),
  };

  keys.set(prefix, registered);
  return registered;
}

/**
 * Decodes one envelope field.
 *
 * Re-encoding is the check: base64 decoding is lenient, so only a field that
 * reproduces itself is the canonical unpadded base64url spelling of its bytes.
 * That rejects padding, foreign characters, and dangling bits — spellings that
 * would otherwise let one ciphertext wear several envelopes.
 *
 * @throws {TokenCryptoError} when `field` is not canonical.
 */
function decodeField(field: string): Buffer {
  const decoded = Buffer.from(field, 'base64url');

  if (decoded.toString('base64url') !== field) {
    throw new TokenCryptoError(MALFORMED);
  }

  return decoded;
}

/**
 * Creates a {@link TokenCrypto} over `options`.
 *
 * Configuration is validated and every key decoded here, once: the returned
 * instance holds 32-byte keys and can then fail only on the input it is given.
 *
 * @throws {TokenCryptoError} when a version is not a positive safe integer, a
 *   key is not 64 hexadecimal characters, or a version is configured twice.
 */
export function createTokenCrypto(options: TokenCryptoOptions): TokenCrypto {
  const keys = new Map<string, VersionedKey>();
  const active = registerKey(keys, options.active, 'Active');

  for (const legacy of options.legacy ?? []) {
    registerKey(keys, legacy, 'Legacy');
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, active.key, iv, { authTagLength: AUTH_TAG_BYTES });

      cipher.setAAD(active.aad);

      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const ivField = iv.toString('base64url');
      const ciphertextField = ciphertext.toString('base64url');
      const authTagField = authTag.toString('base64url');

      return `${active.prefix}:${ivField}:${ciphertextField}:${authTagField}`;
    },

    decrypt(envelope: string): string {
      const firstSeparator = envelope.indexOf(':');
      const secondSeparator = envelope.indexOf(':', firstSeparator + 1);
      const thirdSeparator = envelope.indexOf(':', secondSeparator + 1);

      // Exactly three separators: a missing one leaves an index at -1, and a
      // fourth would carry a field this format has no reader for.
      if (
        firstSeparator < 0 ||
        secondSeparator < 0 ||
        thirdSeparator < 0 ||
        envelope.includes(':', thirdSeparator + 1)
      ) {
        throw new TokenCryptoError(MALFORMED);
      }

      const prefix = envelope.slice(0, firstSeparator);

      if (!VERSION_PREFIX_PATTERN.test(prefix)) {
        throw new TokenCryptoError(MALFORMED);
      }

      const versioned = keys.get(prefix);

      if (versioned === undefined) {
        throw new TokenCryptoError(UNKNOWN_VERSION);
      }

      const iv = decodeField(envelope.slice(firstSeparator + 1, secondSeparator));
      const ciphertext = decodeField(envelope.slice(secondSeparator + 1, thirdSeparator));
      const authTag = decodeField(envelope.slice(thirdSeparator + 1));

      // Only the ciphertext may be empty — encrypting an empty token produces
      // no bytes, while the fixed IV and tag sizes reject an empty field.
      if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new TokenCryptoError(MALFORMED);
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, versioned.key, iv, {
          authTagLength: AUTH_TAG_BYTES,
        });

        decipher.setAAD(versioned.aad);
        decipher.setAuthTag(authTag);

        // `final` is the authentication check; anything it returns before that
        // point is unverified, so nothing here may escape the block early.
        return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
      } catch {
        // A wrong key, a tampered field, and a relabelled version are one
        // outcome: the envelope is not authentic under the version it claims.
        throw new TokenCryptoError(UNDECRYPTABLE);
      }
    },
  };
}
