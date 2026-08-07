import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../src/lib/html.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quote', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes single quote', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes & first so entities are not double-escaped', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('&')).not.toBe('&amp;amp;');
    // Wrong order (& after <) would turn "&lt;" into "&amp;lt;".
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('<')).not.toContain('&amp;');
    expect(escapeHtml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
  });

  it('escapes a reflected XSS payload to inert text', () => {
    const payload = '<script>alert(1)</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).not.toContain('<script>');
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
