import { createHash } from 'node:crypto';

/**
 * Merkle root over the per-Voucher hashes of the Vouchers included in a
 * frozen VAT report (ADR-0013: per-period Merkle root).
 *
 * The LEAVES are the per-Voucher hashes of the hash-chained voucher log
 * (see `computeVoucherHash` in src/ledger/posting/voucher-hash.ts). We REUSE
 * that hash rather than inventing a second hashing scheme: the leaf is exactly
 * the voucher's chain hash, so the Merkle root commits to precisely the chain
 * state of every covered Voucher.
 *
 * LEAF ORDERING is deterministic and fixed: leaves are taken in ascending
 * Voucher `id` order. The caller is responsible for sorting; this function
 * hashes the leaves in the order given. (VatReportService sorts the covered
 * voucher set by id before building leaves.)
 *
 * INTERNAL NODES: `node = SHA-256(left ‖ right)` over the two hex-string
 * children concatenated. When a level has an odd number of nodes, the last
 * node is promoted unchanged to the next level (carry-up, not duplicated) so
 * the tree is unambiguous and a single-leaf set yields that leaf as the root.
 *
 * EDGE CASES:
 *  - empty set  → `null` (no Vouchers ⇒ no integrity proof to store)
 *  - single leaf → the leaf hash itself (no parent to combine)
 */
export function computeMerkleRoot(leafHashes: string[]): string | null {
  if (leafHashes.length === 0) return null;

  let level = [...leafHashes];

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashPair(level[i], level[i + 1]));
      } else {
        // Odd node out: carry it up unchanged.
        next.push(level[i]);
      }
    }
    level = next;
  }

  return level[0];
}

function hashPair(left: string, right: string): string {
  return createHash('sha256')
    .update(left + right)
    .digest('hex');
}
