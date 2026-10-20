/** KMS §15(1), verified dates and primary evidence: docs/research/issue-398-eu-vat.md. */
export function estonianStandardVatRate(onDate: string): number {
  if (onDate >= '2025-07-01') return 0.24;
  if (onDate >= '2024-01-01') return 0.22;
  return 0.2;
}
