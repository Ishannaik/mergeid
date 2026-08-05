import pino from 'pino';

// Redaction paths are intentionally minimal here — the full set is derived from
// the real field names once tokens actually flow (docs/security-model.md, #36).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', '*.token', '*.accessToken', '*.clientSecret'],
    censor: '[redacted]',
  },
});
