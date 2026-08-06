import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('project metadata', () => {
  it('runs as an ESM package that requires Node 22+', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      type: string;
      engines: { node: string };
    };

    expect(pkg.type).toBe('module');
    expect(pkg.engines.node).toBe('>=22');
  });
});
