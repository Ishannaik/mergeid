import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  type?: string;
  engines?: { node?: string };
};

describe('package metadata', () => {
  it('declares ESM support and requires Node.js 22 or newer', () => {
    expect(packageJson).toMatchObject({
      type: 'module',
      engines: { node: '>=22' },
    });
  });
});
