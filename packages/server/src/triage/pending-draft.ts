import type { EntitiesService } from '../entities/entities.service';
import { normalizeIdentifier } from '../entities/identifier-normalization';
import type { EntityWithIdentifiers } from '../entities/types';
import type { SupplierProposal } from './types';
import type { MissingEntityFact } from './types';

export interface SuggestedSupplier {
  id: number;
  name: string;
  country: string;
  registration_key: string | null;
}

export type PendingSupplierProposal =
  | {
      kind: 'create';
      create_name: string;
      create_country: string;
      create_registration_key: string | null;
      create_email: string | null;
      create_phone: string | null;
      create_address: string | null;
    }
  | {
      kind: 'invalid_match';
      observed_country: string | null;
      observed_registration_key: string | null;
      suggested_supplier: SuggestedSupplier | null;
    };

export interface PendingDraft {
  kind: 'supplier_proposal';
  document_id: number;
  reason: string;
  supplier_proposal: PendingSupplierProposal;
  draft: {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    supplier_invoice_number: string | null;
  };
}

/**
 * The typed view of a missing-entity-fact hold (issue #404): the supplier IS
 * resolved (an existing, matched Entity) — only one of its facts is missing.
 * Carries the matched supplier (id, name, country) and WHICH fact is
 * missing, so the doc screen renders supplier + fact controls from typed
 * data, never by parsing the hold prose. The `draft` figures come from the
 * persisted draft Expense the first pass minted — the authoritative record
 * of what was extracted from the document.
 */
export interface MissingEntityFactDraft {
  kind: 'missing_entity_fact';
  document_id: number;
  reason: string;
  /** Which entity fact is missing — one family, one resolution pattern. */
  fact: MissingEntityFact;
  /** The matched supplier the document's draft is booked against. */
  supplier: {
    id: number;
    name: string;
    country: string;
  };
  draft: {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    supplier_invoice_number: string | null;
  };
}

/** Any held document's pending-draft view (issue #404 union). */
export type AnyPendingDraft = PendingDraft | MissingEntityFactDraft;

type IdentifierResolver = Pick<EntitiesService, 'resolveByIdentifier'>;

function toSuggestion(
  entity: EntityWithIdentifiers | undefined,
  registrationKey: string,
): SuggestedSupplier | null {
  if (entity?.role !== 'supplier') return null;

  return {
    id: entity.id,
    name: entity.name,
    country: entity.country,
    registration_key: registrationKey,
  };
}

export async function buildPendingSupplierProposal(
  proposal: SupplierProposal,
  entities: IdentifierResolver,
): Promise<PendingSupplierProposal> {
  if (proposal.mode === 'create') {
    return {
      kind: 'create',
      create_name: proposal.create_name,
      create_country: proposal.create_country,
      create_registration_key: proposal.create_registration_key,
      create_email: proposal.create_email,
      create_phone: proposal.create_phone,
      create_address: proposal.create_address,
    };
  }

  const registrationKey = proposal.observed_registration_key
    ? normalizeIdentifier(
        'registration_key',
        proposal.observed_registration_key,
      )
    : null;
  const matched = registrationKey
    ? await entities.resolveByIdentifier('registration_key', registrationKey)
    : undefined;

  return {
    kind: 'invalid_match',
    observed_country: proposal.observed_country?.trim() || null,
    observed_registration_key: registrationKey,
    suggested_supplier:
      registrationKey === null ? null : toSuggestion(matched, registrationKey),
  };
}
