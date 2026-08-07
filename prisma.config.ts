import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 does not auto-load `.env`, hence the `dotenv/config` import above.
 *
 * `DATABASE_URL` is read via `process.env` rather than Prisma's `env()` helper
 * on purpose: `env()` throws at config-load time when the variable is unset,
 * which breaks `prisma generate` — and therefore `pnpm typecheck` and
 * `pnpm build` — on a clean clone with no database. Codegen never opens a
 * connection, so it does not need a URL. Commands that do connect
 * (`migrate`, `db push`) still fail loudly, because Prisma rejects an
 * undefined `datasource.url` at the point it actually needs one.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
