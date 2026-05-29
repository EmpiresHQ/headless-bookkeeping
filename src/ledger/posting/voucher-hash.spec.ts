import { GENESIS_HASH, computeVoucherHash } from './voucher-hash';

describe('voucher-hash', () => {
  const voucher = {
    voucher_number: 'V-1',
    tax_point_date: '2026-03-15',
    posted_at: 1740000000,
    previous_hash: GENESIS_HASH,
  };
  const lines = [
    { account_id: 1, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: true },
    { account_id: 2, amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, is_debit: false },
  ];

  it('GENESIS_HASH is 64 hex chars of zero', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(computeVoucherHash(voucher, lines)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(computeVoucherHash(voucher, lines)).toBe(computeVoucherHash(voucher, lines));
  });

  it('changes if ANY field changes (tamper sensitivity)', () => {
    const base = computeVoucherHash(voucher, lines);
    expect(computeVoucherHash({ ...voucher, previous_hash: 'deadbeef' }, lines)).not.toBe(base);
    expect(computeVoucherHash(voucher, [{ ...lines[0], amount: 10001 }, lines[1]])).not.toBe(base);
  });
});
