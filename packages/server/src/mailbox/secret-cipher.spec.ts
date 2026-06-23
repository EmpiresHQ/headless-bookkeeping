import { encryptSecret, decryptSecret } from './secret-cipher';

const KEY = '0'.repeat(64); // 32 bytes hex

describe('secret-cipher', () => {
  it('round-trips a secret', () => {
    const c = encryptSecret('hunter2-refresh-token', KEY);
    expect(c).not.toContain('hunter2');
    expect(decryptSecret(c, KEY)).toBe('hunter2-refresh-token');
  });

  it('produces a fresh IV each call (ciphertext differs)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('throws on a tampered ciphertext', () => {
    const c = encryptSecret('x', KEY);
    const tampered = c.slice(0, -2) + (c.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws on a wrong-length key', () => {
    expect(() => encryptSecret('x', 'abcd')).toThrow(/32-byte/);
  });
});
