/**
 * Kernel-level posting convention: the VAT code that marks a VoucherLine as
 * NOT subject to VAT reporting.
 *
 * This is a KERNEL convention, not a jurisdiction VAT code. The posting layer
 * (PostingService, PostingPipelineService) tags non-VAT-reportable lines
 * (AR, AP, Bank, Equity, …) with this sentinel so the semantic tier and VAT
 * reports skip them. It is the SOURCE OF TRUTH for "this line carries no real
 * VAT code" — owned by the kernel, never by a country plugin (ADR-0002: a
 * country plugin is the sole resolver of a *jurisdiction* VAT code, which this
 * is not).
 *
 * The literal value `'NULL_STANDARD'` is PERSISTED on existing voucher_line
 * rows and matched by value — do NOT change the string.
 *
 * This is a deliberately dependency-free leaf module so both the kernel
 * posting layer and a country plugin (which may legitimately list it among the
 * codes it recognizes) can import it without a circular dependency on the
 * posting module.
 */
export const NULL_VAT_CODE = 'NULL_STANDARD';
