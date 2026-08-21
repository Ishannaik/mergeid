import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';

import { decryptToken, encryptToken, TokenCryptoError } from '../../src/crypto/token.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('token crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const plaintext = 'gho_test-access-token-value';
    const sealed = encryptToken(plaintext, { keyHex: KEY_A, keyVersion: '1' });

    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed.split(':')).toHaveLength(4);
    expect(decryptToken(sealed, { keyHex: KEY_A })).toBe(plaintext);
  });

  it('fails when decrypting with the wrong key', () => {
    const sealed = encryptToken('secret-token', { keyHex: KEY_A, keyVersion: '1' });

    expect(() => decryptToken(sealed, { keyHex: KEY_B })).toThrow(TokenCryptoError);
  });

  it('rejects tampered ciphertext (auth tag must fail closed)', () => {
    const sealed = encryptToken('secret-token', { keyHex: KEY_A, keyVersion: '1' });
    const parts = sealed.split(':');
    const cipherBuf = Buffer.from(parts[2]!, 'base64url');
    cipherBuf[0] = cipherBuf[0]! ^ 0xff;
    parts[2] = cipherBuf.toString('base64url');
    const tampered = parts.join(':');

    expect(() => decryptToken(tampered, { keyHex: KEY_A })).toThrow(TokenCryptoError);
  });

  it('rejects a forged payload with a swapped auth tag', () => {
    // Build two valid ciphertexts then swap tags — GCM must refuse both.
    const a = encryptToken('token-a', { keyHex: KEY_A, keyVersion: '1' }).split(':');
    const b = encryptToken('token-b', { keyHex: KEY_A, keyVersion: '1' }).split(':');
    const swapped = [a[0], a[1], a[2], b[3]].join(':');

    expect(() => decryptToken(swapped, { keyHex: KEY_A })).toThrow(TokenCryptoError);
  });

  it('uses a fresh IV per encryption', () => {
    const one = encryptToken('same', { keyHex: KEY_A, keyVersion: '1' });
    const two = encryptToken('same', { keyHex: KEY_A, keyVersion: '1' });
    expect(one).not.toBe(two);
    expect(one.split(':')[1]).not.toBe(two.split(':')[1]);
  });
});

describe('token crypto wire format', () => {
  it('can decrypt a hand-built v1 payload (documents the on-disk format)', () => {
    const iv = randomBytes(12);
    const key = Buffer.from(KEY_A, 'hex');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('hand-built', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = `v1:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;

    expect(decryptToken(payload, { keyHex: KEY_A })).toBe('hand-built');
  });
});
