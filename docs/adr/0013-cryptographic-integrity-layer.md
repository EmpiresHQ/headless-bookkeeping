# Cryptographic integrity layer: hash-chained voucher log + per-period Merkle root

On top of (not instead of) double-entry, the append-only voucher log is made tamper-evident. Double-entry and hashing are orthogonal: double-entry proves *what* is recorded is correct (it balances; it yields P&L / balance sheet / VAT); the hash layer proves the records *were not altered* after the fact. A hash chain alone could faithfully preserve unbalanced garbage; double-entry alone can't prove non-tampering. We want both.

This composes naturally with decisions already made — vouchers are immutable and append-only (corrections are reversals, never edits), which is exactly the discipline a hash chain needs.

- **Hash chain over the voucher log.** Each posted Voucher commits to the hash of the previous ledger state (git-commit style). "We don't edit posted vouchers" becomes "you can verify we didn't." Cost: one hash column in SQLite.
- **Merkle root per locked period.** When a Reporting period is filed, compute a Merkle root over the exact set of vouchers in its frozen VAT report (ADR-0009) and store it in the VAT report. This gives a compact cryptographic proof of precisely what was filed and that it hasn't changed since.
- **Optional external anchor** (deferred): publishing/timestamping the period root externally lets a third party (auditor) verify the filed return without seeing the whole ledger.

v1 builds the hash chain and the per-period Merkle root; the external anchor is deferred. Double-entry remains the unchanged semantic core.
