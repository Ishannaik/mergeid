import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads .env. Node's built-in loader keeps this a
// zero-dependency step; CI and containers supply the environment directly, so a
// missing .env is not an error.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env on disk — fall through to the ambient environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Prisma 7 moved the connection string out of schema.prisma. Used by Migrate
  // and Studio only — the runtime client gets a driver adapter instead.
  //
  // Read via process.env rather than the `env()` helper on purpose: `env()`
  // throws while the config file loads, which would break `prisma generate` in
  // CI, where there is no database to point at. The commands that genuinely
  // need a connection still fail with their own clear error.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
