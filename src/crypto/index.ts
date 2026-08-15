/**
 * Public surface of the token encryption module.
 *
 * Callers depend on this barrel rather than on `token.js`, so the envelope
 * implementation stays free to move behind it.
 */

export {
  createTokenCrypto,
  TokenCryptoError,
  type TokenCrypto,
  type TokenCryptoOptions,
  type TokenEncryptionKey,
} from './token.js';
