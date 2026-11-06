/** Slow local models need a full ten minutes per generation. */
export const AI_REQUEST_TIMEOUT_MS = 600_000;
export const CLASSIFICATION_MAX_ATTEMPTS = 3;
export const EVIDENCE_MAX_ATTEMPTS = 2;

/** Gate + all bounded evidence/classification attempts, plus 15 minutes
 * for OCR and other intake work. Never reclaim a normally running generation. */
export const INTAKE_STALE_SECONDS =
  ((1 + EVIDENCE_MAX_ATTEMPTS + CLASSIFICATION_MAX_ATTEMPTS) *
    AI_REQUEST_TIMEOUT_MS) /
    1000 +
  15 * 60;
