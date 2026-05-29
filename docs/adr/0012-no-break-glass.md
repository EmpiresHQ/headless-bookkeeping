# No break-glass: the only escape valve is the logged semantic Override

There is deliberately no mechanism — for any user, admin, or agent — to force-post a voucher that violates structural invariants (must balance, account exists) or that writes into a locked (filed) period. The absence of a break-glass is itself the feature: a system where anyone can bypass the arithmetic or the filed-period lock is not accounting-safe, and such a bypass is precisely what auditors and tax authorities look for and what fraud exploits.

Every legitimate need that might seem to want a bypass is already covered by a controlled mechanism:

- **Too-strict / buggy semantic (country) rule** → logged Override (ADR-0005), with a reason and audit trail. This is the only escape valve, and it lives *inside* the rules.
- **Migration / opening balances** → a first-class, still-balanced posting flow (Dr assets / Cr equity, equity as the plug), in a dedicated migration period. Semantic checks may be relaxed there (legacy data may lack a VAT code); structural invariants never are; everything is logged.
- **Rounding (1-cent) imbalance** → a rounding account + the plugin's rounding rule, not a bypass.
- **Agent down, enter manually** → the normal manual path through the same pipeline (a human bypasses AI/OCR, never Rules).

If a structural rule is genuinely buggy, the fix is the code/plugin — never punching the bug's output permanently into the ledger.

## Wave-3 review note — "logged" is load-bearing

The escape valve is only legitimate if it is *actually logged*. The Wave-3 pipeline applied a semantic override but did not persist the `override` row (see ADR-0005, Wave-3 review amendment), which would have produced an excused-but-unaudited posting — exactly the silent bypass this ADR forbids. The remediation makes override persistence atomic with the post: an overridden voucher and its audit row commit together or not at all.
