import { createHash } from 'node:crypto';
import { computeMerkleRoot } from './merkle';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('computeMerkleRoot (ADR-0013 per-period Merkle root)', () => {
  it('returns null for an empty leaf set', () => {
    expect(computeMerkleRoot([])).toBeNull();
  });

  it('returns the leaf itself for a single-leaf set', () => {
    const leaf = sha('voucher-1');
    expect(computeMerkleRoot([leaf])).toBe(leaf);
  });

  it('hashes a pair as SHA-256(left ‖ right)', () => {
    const a = sha('a');
    const b = sha('b');
    expect(computeMerkleRoot([a, b])).toBe(sha(a + b));
  });

  it('carries an odd node up unchanged', () => {
    const a = sha('a');
    const b = sha('b');
    const c = sha('c');
    // level0: [a,b,c] -> level1: [H(a||b), c] -> root: H(H(a||b)||c)
    const ab = sha(a + b);
    expect(computeMerkleRoot([a, b, c])).toBe(sha(ab + c));
  });

  it('is deterministic and order-sensitive', () => {
    const a = sha('a');
    const b = sha('b');
    expect(computeMerkleRoot([a, b])).toBe(computeMerkleRoot([a, b]));
    expect(computeMerkleRoot([a, b])).not.toBe(computeMerkleRoot([b, a]));
  });
});
