import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { createTokenCrypto, TokenCryptoError } from '../../src/crypto/index.js';

const keyV1 = '11'.repeat(32);
const keyV2 = '22'.repeat(32);
const keyV3 = '33'.repeat(32);

function makeCrypto(
  active: { version: number; key: string } = { version: 1, key: keyV1 },
  legacy: readonly { version: number; key: string }[] = [],
) {
  return createTokenCrypto({ active, legacy });
}

function decodeCanonicalBase64Url(value: string): Buffer {
  expect(value).toMatch(/^[A-Za-z0-9_-]+$/);

  const decoded = Buffer.from(value, 'base64url');
  expect(decoded.toString('base64url')).toBe(value);
  return decoded;
}

function alterBase64Url(value: string): string {
  const replacement = value[0] === 'A' ? 'B' : 'A';
  return `${replacement}${value.slice(1)}`;
}

function alterEncodedByte(value: string, byteIndex: number): string {
  const decoded = decodeCanonicalBase64Url(value);
  const index = byteIndex < 0 ? decoded.length + byteIndex : byteIndex;
  decoded[index] = decoded[index]! ^ 1;
  return decoded.toString('base64url');
}

function expectTokenCryptoError(operation: () => unknown): TokenCryptoError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenCryptoError);
    return error as TokenCryptoError;
  }

  throw new Error('Expected TokenCryptoError');
}

describe('createTokenCrypto', () => {
  it.each(['ordinary token', 'Grüße 👋 — 秘密', ''])('round-trips %j', (plaintext) => {
    const crypto = makeCrypto();

    expect(crypto.decrypt(crypto.encrypt(plaintext))).toBe(plaintext);
  });

  it('emits a four-part versioned canonical envelope with a 12-byte IV and 16-byte tag', () => {
    const envelope = makeCrypto().encrypt('token');
    const parts = envelope.split(':');

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(parts[0]).toMatch(/^v[1-9][0-9]*$/);
    expect(decodeCanonicalBase64Url(parts[1]!)).toHaveLength(12);
    expect(decodeCanonicalBase64Url(parts[2]!).length).toBeGreaterThan(0);
    expect(decodeCanonicalBase64Url(parts[3]!)).toHaveLength(16);
  });

  it('uses fresh randomized IVs, ciphertexts, authentication tags, and envelopes', () => {
    const crypto = makeCrypto();
    const first = crypto.encrypt('same token').split(':');
    const second = crypto.encrypt('same token').split(':');

    expect(first.join(':')).not.toBe(second.join(':'));
    expect(first[1]).not.toBe(second[1]);
    expect(first[2]).not.toBe(second[2]);
    expect(first[3]).not.toBe(second[3]);
    expect(crypto.decrypt(first.join(':'))).toBe('same token');
    expect(crypto.decrypt(second.join(':'))).toBe('same token');
  });

  it('decrypts a legacy v1 envelope after rotating active encryption to v2', () => {
    const v1Envelope = makeCrypto().encrypt('rotated token');
    const rotated = makeCrypto({ version: 2, key: keyV2 }, [{ version: 1, key: keyV1 }]);
    const v2Envelope = rotated.encrypt('new token');

    expect(rotated.decrypt(v1Envelope)).toBe('rotated token');
    expect(v2Envelope).toMatch(/^v2:/);
    expect(rotated.decrypt(v2Envelope)).toBe('new token');
  });

  it('rejects a changed IV byte with TokenCryptoError', () => {
    const crypto = makeCrypto();
    const parts = crypto.encrypt('tamper target').split(':');
    const tampered = `${parts[0]}:${alterEncodedByte(parts[1]!, 0)}:${parts[2]}:${parts[3]}`;

    expect(() => crypto.decrypt(tampered)).toThrow(TokenCryptoError);
  });

  it('rejects a changed ciphertext with TokenCryptoError', () => {
    const crypto = makeCrypto();
    const parts = crypto.encrypt('tamper target').split(':');
    const tampered = `${parts[0]}:${parts[1]}:${alterBase64Url(parts[2]!)}:${parts[3]}`;

    expect(() => crypto.decrypt(tampered)).toThrow(TokenCryptoError);
  });

  it('rejects a changed final authentication tag byte with TokenCryptoError', () => {
    const crypto = makeCrypto();
    const parts = crypto.encrypt('tamper target').split(':');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${alterEncodedByte(parts[3]!, -1)}`;

    expect(() => crypto.decrypt(tampered)).toThrow(TokenCryptoError);
  });

  it('rejects a canonically encoded truncated authentication tag with TokenCryptoError', () => {
    const crypto = makeCrypto();
    const parts = crypto.encrypt('tamper target').split(':');
    const truncated = `${parts[0]}:${parts[1]}:${parts[2]}:${decodeCanonicalBase64Url(parts[3]!)
      .subarray(0, -1)
      .toString('base64url')}`;
    expect(() => crypto.decrypt(truncated)).toThrow(TokenCryptoError);
  });

  it('rejects a changed version even when the replacement version uses the same key', () => {
    const crypto = makeCrypto({ version: 1, key: keyV1 }, [{ version: 2, key: keyV1 }]);
    const envelope = crypto.encrypt('tamper target');

    expect(() => crypto.decrypt(`v2${envelope.slice(2)}`)).toThrow(TokenCryptoError);
  });

  it('rejects an unknown version with TokenCryptoError', () => {
    const envelope = makeCrypto().encrypt('tamper target');

    expect(() => makeCrypto().decrypt(`v3${envelope.slice(2)}`)).toThrow(TokenCryptoError);
  });

  it('rejects an envelope encrypted with a different key', () => {
    const envelope = makeCrypto().encrypt('token');

    expect(() => makeCrypto({ version: 1, key: keyV2 }).decrypt(envelope)).toThrow(
      TokenCryptoError,
    );
  });

  it.each([
    '',
    'v1',
    'v1:iv:ciphertext',
    'v1::ciphertext:tag',
    'v0:AAAAAAAAAAAAAAAA:AA:AAAAAAAAAAAAAAAAAAAAAA',
    'v01:AAAAAAAAAAAAAAAA:AA:AAAAAAAAAAAAAAAAAAAAAA',
    'v1:AAAAAAAAAAAAAAA:AA:AAAAAAAAAAAAAAAAAAAAAA',
    'v1:AAAAAAAAAAAAAAAA:AA:AAAAAAAAAAAAAAAAAAAAA',
    'v1:AAAAAAAAAAAAAAAA:=:AAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects malformed envelope %j with TokenCryptoError', (envelope) => {
    expect(() => makeCrypto().decrypt(envelope)).toThrow(TokenCryptoError);
  });

  it('rejects byte-equivalent noncanonical envelope encodings', () => {
    const crypto = makeCrypto();
    const parts = crypto.encrypt('canonical target').split(':');
    const paddedIv = `${parts[0]}:${parts[1]}=:${parts[2]}:${parts[3]}`;
    const paddedCiphertext = `${parts[0]}:${parts[1]}:${parts[2]}=:${parts[3]}`;
    const paddedTag = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}=`;
    const noncanonicalVersion = `v01${parts[0]!.slice(2)}:${parts[1]}:${parts[2]}:${parts[3]}`;

    expect(() => crypto.decrypt(paddedIv)).toThrow(TokenCryptoError);
    expect(() => crypto.decrypt(paddedCiphertext)).toThrow(TokenCryptoError);
    expect(() => crypto.decrypt(paddedTag)).toThrow(TokenCryptoError);
    expect(() => crypto.decrypt(noncanonicalVersion)).toThrow(TokenCryptoError);
  });

  it.each([
    ['an active short key', () => makeCrypto({ version: 1, key: '11'.repeat(31) })],
    ['an active non-hex key', () => makeCrypto({ version: 1, key: `${'11'.repeat(31)}zz` })],
    [
      'a legacy short key',
      () => makeCrypto({ version: 1, key: keyV1 }, [{ version: 2, key: '22'.repeat(31) }]),
    ],
    [
      'a legacy non-hex key',
      () => makeCrypto({ version: 1, key: keyV1 }, [{ version: 2, key: `${'22'.repeat(31)}zz` }]),
    ],
  ])('rejects %s during factory creation', (_description, create) => {
    expect(create).toThrow(TokenCryptoError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid active version %s during factory creation',
    (version) => {
      expect(() => makeCrypto({ version, key: keyV1 })).toThrow(TokenCryptoError);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid legacy version %s during factory creation',
    (version) => {
      expect(() => makeCrypto({ version: 1, key: keyV1 }, [{ version, key: keyV2 }])).toThrow(
        TokenCryptoError,
      );
    },
  );

  it('rejects duplicate active and legacy key versions during factory creation', () => {
    expect(() =>
      makeCrypto({ version: 1, key: keyV1 }, [
        { version: 1, key: keyV2 },
        { version: 2, key: keyV3 },
        { version: 2, key: keyV1 },
      ]),
    ).toThrow(TokenCryptoError);
  });

  it('rejects duplicate legacy versions during factory creation', () => {
    expect(() =>
      makeCrypto({ version: 1, key: keyV1 }, [
        { version: 2, key: keyV2 },
        { version: 2, key: keyV3 },
      ]),
    ).toThrow(TokenCryptoError);
  });

  it('does not reveal secrets in wrong-key or authentication-tag failure errors', () => {
    const plaintext = 'plaintext-must-not-appear-in-errors';
    const crypto = makeCrypto();
    const envelope = crypto.encrypt(plaintext);
    const parts = envelope.split(':');
    const wrongKeyError = expectTokenCryptoError(() =>
      makeCrypto({ version: 1, key: keyV2 }).decrypt(envelope),
    );
    const tamperedTag = `${parts[0]}:${parts[1]}:${parts[2]}:${alterEncodedByte(parts[3]!, -1)}`;
    const tamperedTagError = expectTokenCryptoError(() => crypto.decrypt(tamperedTag));

    for (const error of [wrongKeyError, tamperedTagError]) {
      for (const secret of [keyV1, keyV2, plaintext, envelope, ...parts]) {
        expect(error.message).not.toContain(secret);
      }
    }
  });

  it('does not reveal an invalid key in factory-creation errors', () => {
    const invalidKey = 'invalid-key-must-not-appear-in-errors';
    const error = expectTokenCryptoError(() => makeCrypto({ version: 1, key: invalidKey }));

    expect(error.message).not.toContain(invalidKey);
  });
});
