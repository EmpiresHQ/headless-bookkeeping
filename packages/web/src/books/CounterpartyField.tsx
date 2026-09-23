import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  onboardEntity,
  type Entity,
  type OnboardEntityInput,
  type TaxStatus,
} from '../api';
import {
  GOODS_OPTIONS,
  REG_KEY_HINT,
  TAX_STATUS_HINT,
  TAX_STATUS_OPTIONS,
  type GoodsOrServices,
} from '../lib/entityOptions';
import {
  errorMessage,
  rethrowIfEnded,
  type PendingOperation,
} from '../lib/pendingOperation';
import { useReceipt } from '../lib/resultLog';
import { sameValues } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';
import {
  useCustomers,
  useOrganizationCountry,
  useSuppliers,
} from '../queries/shared';
import { Button } from '../ui/Button';
import { HttpError } from '../auth';
import {
  blockComposingEnter,
  Field,
  noImplicitSubmit,
  SelectInput,
  TextInput,
  useFormErrors,
} from '../ui/Form';
import {
  lookupBlocker,
  lookupState,
  LookupNotice,
  useEntityPick,
} from '../ui/Lookup';
import { SearchInput } from '../ui/SearchInput';
import { toastErr } from '../ui/toast';

/**
 * The counterparty of a manual expense (supplier) or sales invoice
 * (customer), issue #263: find it or add it WITHOUT leaving the form — the
 * amounts and dates typed so far stay where they are. The role is the
 * form's, never a choice.
 *
 * Adding one is a plain insert on the server (EntitiesService.onboard): it
 * never returns an existing entity and nothing rejects a second one with the
 * same registration key — so search comes first, an existing same-named
 * entity is offered instead, and a create is sent once per explicit click,
 * never replayed.
 *
 * It shares the sheet's ONE pending operation (issue #251): adding the
 * counterparty and creating the draft never overlap, and while either is in
 * flight the sheet is busy (no dismiss, no route leave, fields locked).
 */
export type CounterpartyRole = 'supplier' | 'customer';

const WORDS: Record<
  CounterpartyRole,
  { one: string; many: string; label: string }
> = {
  supplier: { one: 'supplier', many: 'suppliers', label: 'Supplier' },
  customer: { one: 'customer', many: 'customers', label: 'Customer' },
};

/** Rows shown before "refine the search". */
const MAX_ROWS = 8;

export interface CounterpartyDraft {
  name: string;
  /** Typed only — the organization's country shown as default is not. */
  country: string;
  regKey: string;
  goods: GoodsOrServices;
  taxStatus: TaxStatus;
}

export const EMPTY_COUNTERPARTY_DRAFT: CounterpartyDraft = {
  name: '',
  country: '',
  regKey: '',
  goods: 'unknown',
  taxStatus: 'unknown',
};

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Any field moved off its default — a started add, kept until it is
 *  added, discarded or replaced by a pick. */
const draftStarted = (d: CounterpartyDraft) =>
  !sameValues(d, EMPTY_COUNTERPARTY_DRAFT);

export function useCounterparty({
  role,
  op,
  onStart,
}: {
  role: CounterpartyRole;
  /** The sheet's pending operation (shared with its submit). */
  op: PendingOperation;
  /** Called when THIS field's create started (the sheet shows which). */
  onStart: () => void;
}) {
  const qc = useQueryClient();
  const suppliersQ = useSuppliers();
  const customersQ = useCustomers();
  const query = role === 'supplier' ? suppliersQ : customersQ;
  const pick = useEntityPick(query);
  const receipt = useReceipt();
  const series = useRef(0);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY_COUNTERPARTY_DRAFT);
  const [createError, setCreateError] = useState<string | null>(null);
  // The refused add and what it sent (issue #265): the Zod pipe's field
  // errors are shown at their fields while those still hold the sent value.
  const [createFailure, setCreateFailure] = useState<{
    error: unknown;
    sent: Record<CreateFieldKey, string>;
  } | null>(null);
  const w = WORDS[role];

  const choose = (e: Entity | null) => {
    // An explicit choice (an entity, or "none") settles the add intent.
    pick.set(e);
    setCreating(false);
    setDraft(EMPTY_COUNTERPARTY_DRAFT);
    setCreateError(null);
    setCreateFailure(null);
    setSearch('');
  };

  const create = (country: string) => {
    const name = draft.name.trim();
    const regKey = draft.regKey.trim();
    const cc = country.trim().toUpperCase();
    if (name === '' || regKey === '' || cc === '') return;
    const req: OnboardEntityInput = {
      role,
      name,
      country: cc,
      registrationKey: regKey,
      goodsVsServices: draft.goods,
      taxStatus: draft.taxStatus,
    };
    const key = `onboard:${series.current}`;
    let accepted = false;
    const started = op.run(
      async (ctx) => {
        const entity = await onboardEntity(req);
        accepted = true;
        series.current += 1;
        ctx.check();
        receipt(
          key,
          {
            action: `New ${w.one}`,
            title: entity.name,
            outcome: `${w.label} added (#${entity.id}) — it is linked to nothing until the ${role === 'supplier' ? 'expense' : 'invoice'} is created.`,
            tone: 'ok',
            links: [
              { label: entity.name, to: `/settings/entities/${entity.id}` },
            ],
          },
          ctx.live,
        );
        // Settled before the pick (#260): no list fetch that predates the
        // creation can land after it and read as its removal. A failed
        // refresh does not undo the answer — the server's entity IS it.
        try {
          await qc.invalidateQueries({ queryKey: sharedKeys.entities });
        } catch (e) {
          rethrowIfEnded(e);
        }
        ctx.check();
        return entity;
      },
      {
        onSuccess: (entity) => {
          pick.set(entity, { created: true });
          setCreating(false);
          setDraft(EMPTY_COUNTERPARTY_DRAFT);
          setCreateError(null);
          setCreateFailure(null);
          setSearch('');
        },
        onError: (e) => {
          toastErr(errorMessage(e));
          if (accepted) return;
          // Whether the server stored it is unknown; the input stays for a
          // deliberate retry, and a fresh list may show it if it was stored.
          setCreateError(errorMessage(e));
          setCreateFailure({
            error: e,
            sent: { name: draft.name, country, regKey: draft.regKey },
          });
          receipt(key, {
            action: `New ${w.one}`,
            title: name,
            outcome: `Adding the ${w.one} was not confirmed (${errorMessage(e)}). Check Settings → Entities before adding it again, in case it was stored.`,
            tone: 'error',
            links: [{ label: 'Entities', to: '/settings/entities' }],
          });
          void qc.invalidateQueries({ queryKey: sharedKeys.entities });
        },
      },
    );
    if (started) onStart();
  };

  const entity = pick.entity;
  const pendingDraft = entity === null && (creating || draftStarted(draft));
  // Why the sheet's submit waits on this field (null = it doesn't).
  const blocker =
    entity !== null
      ? pick.gone
        ? `The chosen ${w.one} is no longer available — change it, or clear it to continue without one.`
        : null
      : pendingDraft
        ? `Finish adding the new ${w.one}, or discard it to continue without one.`
        : lookupBlocker(query, w.many);

  return {
    role,
    query,
    words: w,
    entity,
    gone: pick.gone,
    /** For the sheet's unsaved-input guard. */
    guardValue: { id: entity?.id ?? null, draft },
    blocker,
    search,
    setSearch,
    creating,
    draft,
    setDraft,
    createError,
    createFailure,
    choose,
    create,
    startCreate: () => {
      setDraft((d) =>
        d.name === '' && search.trim() !== ''
          ? { ...d, name: search.trim() }
          : d,
      );
      setCreateError(null);
      setCreateFailure(null);
      setCreating(true);
    },
    backToSearch: () => setCreating(false),
    discardDraft: () => {
      setDraft(EMPTY_COUNTERPARTY_DRAFT);
      setCreateError(null);
      setCreateFailure(null);
      setCreating(false);
    },
  };
}

export type Counterparty = ReturnType<typeof useCounterparty>;

type CreateFieldKey = 'name' | 'country' | 'regKey';
const CREATE_SERVER_FIELDS: Record<string, CreateFieldKey> = {
  name: 'name',
  country: 'country',
  registrationKey: 'regKey',
};

export function CounterpartyField({
  cp,
  hint,
  busy,
  focusId,
  error = null,
}: {
  cp: Counterparty;
  /** Why it is optional, shown with the search. */
  hint: string;
  /** This field's create is in flight. */
  busy: boolean;
  /** Id for the control the form focuses for this field (issue #265) —
   *  whichever mode is showing: the search, the picked row's Change, or
   *  the new-counterparty group. */
  focusId?: string;
  /** The form's error for this field (e.g. the server refused the id). */
  error?: string | null;
}) {
  const { words: w, query } = cp;
  return (
    <div>
      {cp.entity !== null ? (
        <Picked cp={cp} focusId={focusId} error={error} />
      ) : cp.creating ? (
        <CreateForm cp={cp} busy={busy} focusId={focusId} error={error} />
      ) : (
        <SearchList cp={cp} hint={hint} focusId={focusId} error={error} />
      )}
      {/* Every mode — searching, adding or picked: a failed load/refresh
          and its Retry never disappear (#260). */}
      <LookupNotice query={query} what={w.many} />
      {cp.entity === null &&
        !cp.creating &&
        (lookupState(query) === 'loading' ||
          lookupState(query) === 'error') && (
          <p className="mt-1 text-[12.5px] text-ink-2">
            Without the {w.one} list an existing {w.one} may not be shown — add
            one only if you are sure it is new.
          </p>
        )}
    </div>
  );
}

type Focus = { focusId?: string; error: string | null };

function Picked({ cp, focusId, error }: { cp: Counterparty } & Focus) {
  const { words: w } = cp;
  const e = cp.entity as Entity;
  return (
    <Field
      label={w.label}
      group
      error={
        cp.gone ? `This ${w.one} is no longer available — change it` : error
      }
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
        <span className="min-w-0 break-words text-[15px] font-semibold">
          {e.name}
          <span className="font-normal text-ink-2">
            {` · ${e.country} · #${e.id}`}
          </span>
          {cp.gone && ' (not available)'}
        </span>
        <button
          id={focusId}
          type="button"
          onClick={() => cp.choose(null)}
          className="flex-none text-[13px] font-semibold text-accent"
        >
          Change
        </button>
      </div>
    </Field>
  );
}

function SearchList({
  cp,
  hint,
  focusId,
  error,
}: { cp: Counterparty; hint: string } & Focus) {
  const { words: w, query } = cp;
  const state = lookupState(query);
  const list = query.data;
  const q = norm(cp.search);
  const matches = (list ?? []).filter((e) => norm(e.name).includes(q));
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const kept = draftStarted(cp.draft);
  const keptName = cp.draft.name.trim();
  return (
    <>
      <div>
        <span id={labelId} className="mb-1 block text-[13px] font-semibold">
          {w.label}
        </span>
        <SearchInput
          id={focusId}
          aria-labelledby={labelId}
          aria-describedby={error !== null ? `${errId} ${hintId}` : hintId}
          aria-invalid={error !== null ? true : undefined}
          value={cp.search}
          onChange={cp.setSearch}
          // Enter only narrows the list — it never creates the sheet's
          // draft before a choice (issue #266).
          onKeyDown={noImplicitSubmit}
          placeholder={`Search ${w.many}…`}
        />
        <span id={hintId} className="mt-1 block text-xs text-ink-2">
          {state === 'ready' && list?.length === 0
            ? `${hint} — no ${w.many} on file yet`
            : hint}
        </span>
        {error !== null && (
          <span id={errId} className="mt-1 block text-xs text-err">
            {error}
          </span>
        )}
      </div>
      {list !== undefined && (
        <div className="mt-1 overflow-hidden rounded-xl bg-surface">
          {matches.slice(0, MAX_ROWS).map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => cp.choose(e)}
              className="flex w-full items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 text-left text-[14px] font-semibold last:border-b-0"
            >
              <span className="min-w-0 break-words">{e.name}</span>
              <span className="flex-none text-[12px] font-normal text-ink-2">
                {`${e.country} · #${e.id}`}
              </span>
            </button>
          ))}
          {matches.length > MAX_ROWS && (
            <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
              {`${matches.length - MAX_ROWS} more — refine the search`}
            </p>
          )}
          {matches.length === 0 && list.length > 0 && (
            <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
              {state === 'stale'
                ? 'No matches in the list loaded earlier — it could not be refreshed'
                : `No matches — add it with “New ${w.one}…” below`}
            </p>
          )}
        </div>
      )}
      {kept ? (
        <div
          role="status"
          className="mt-1.5 rounded-xl bg-warn-bg px-3 py-2 text-[12.5px] text-warn"
        >
          <p className="font-semibold">
            {`The new ${w.one}${keptName !== '' ? ` “${keptName}”` : ''} you started is not added yet — pick one above, continue adding it, or discard it.`}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-[13px]"
              onClick={cp.startCreate}
            >
              Continue adding
            </Button>
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-[13px]"
              onClick={cp.discardDraft}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={cp.startCreate}
          className="mt-1.5 text-[13px] font-semibold text-accent"
        >
          {`New ${w.one}…`}
        </button>
      )}
    </>
  );
}

function CreateForm({
  cp,
  busy,
  focusId,
  error,
}: { cp: Counterparty; busy: boolean } & Focus) {
  const { words: w, draft, setDraft, query } = cp;
  // Mounted only while adding: the organization's country is a default only
  // once it is KNOWN (#260) — a typed country always wins.
  const countryQ = useOrganizationCountry();
  const countryState = lookupState(countryQ);
  const effCountry =
    draft.country !== '' ? draft.country : (countryQ.data ?? '');
  // Required by the add (issue #265): the server needs a registration key
  // for a supplier/customer; name and country are the entity itself.
  const v = useFormErrors({
    values: { name: draft.name, country: effCountry, regKey: draft.regKey },
    errors: {
      name: draft.name.trim() === '' ? `Enter the ${w.one}'s name` : null,
      country:
        effCountry.trim() === '' ? 'Enter the country code, e.g. EE' : null,
      regKey:
        draft.regKey.trim() === ''
          ? `Enter the registration key — a ${w.one} needs one`
          : null,
    },
    labels: { name: 'Name', country: 'Country', regKey: 'Registration key' },
  });
  // The server's own field errors for the refused add, while the field
  // still holds what was sent — only its structured 400, only known keys.
  const serverError = (k: CreateFieldKey): string | null => {
    const f = cp.createFailure;
    const val = f?.error instanceof HttpError ? f.error.validation : null;
    if (f === null || val === null) return null;
    const current = {
      name: draft.name,
      country: effCountry,
      regKey: draft.regKey,
    };
    if (current[k] !== f.sent[k]) return null;
    const hit = Object.entries(val.fields).find(
      ([key]) =>
        Object.prototype.hasOwnProperty.call(CREATE_SERVER_FIELDS, key) &&
        CREATE_SERVER_FIELDS[key] === k,
    );
    return hit === undefined ? null : hit[1].join('; ');
  };
  const fieldError = (k: CreateFieldKey) => v.error(k) ?? serverError(k);
  // Its own submit (issue #266): these controls join a separate form — never
  // one nested in the sheet's — so Enter here adds the counterparty (through
  // the same gate as the button) and never submits the draft around it.
  // The empty form element lives outside the sheet's form; `add` is its one
  // submit path, the shared operation's lock keeps it to one request.
  const formId = `${useId()}-form`;
  const add = () => {
    if (v.attempt()) cp.create(effCountry);
  };
  const set = <K extends keyof CounterpartyDraft>(
    k: K,
    v: CounterpartyDraft[K],
  ) => setDraft((d) => ({ ...d, [k]: v }));
  // Names are not unique: every entity of this role with the typed name is
  // offered with its country and id, from the list as it is known.
  const sameName =
    draft.name.trim() === ''
      ? []
      : (query.data ?? []).filter((e) => norm(e.name) === norm(draft.name));
  return (
    <div
      id={focusId}
      tabIndex={focusId !== undefined ? -1 : undefined}
      role="group"
      aria-label={`New ${w.one}`}
      // These controls are not inside their (portalled) form's DOM: the
      // composing-Enter guard sits on their own ancestor (issue #266).
      onKeyDown={blockComposingEnter}
      className="space-y-3 rounded-2xl border-[1.5px] border-dashed border-line bg-surface p-3.5 outline-none"
    >
      {createPortal(
        <form
          id={formId}
          noValidate
          hidden
          onSubmit={(e) => {
            e.preventDefault();
            // Portalled: React would still bubble it to the sheet's form.
            e.stopPropagation();
            add();
          }}
        />,
        document.body,
      )}
      <p className="text-[13px] font-semibold">
        {`New ${w.one} — added to Entities as a ${w.one}`}
      </p>
      {error !== null && <p className="text-xs text-err">{error}</p>}
      <Field label="Name" required error={fieldError('name')}>
        <TextInput
          {...v.bind('name')}
          form={formId}
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>
      {sameName.length > 0 && (
        <div
          role="status"
          className="rounded-xl bg-warn-bg px-3 py-2 text-[12.5px] text-warn"
        >
          <p className="font-semibold">
            {`${sameName.length === 1 ? `A ${w.one} with this name is` : `${sameName.length} ${w.many} with this name are`} already on file${lookupState(query) === 'stale' ? ' (in the list loaded earlier)' : ''} — adding creates another one.`}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {sameName.slice(0, MAX_ROWS).map((e) => (
              <Button
                key={e.id}
                variant="secondary"
                className="px-3 py-1.5 text-[13px]"
                onClick={() => cp.choose(e)}
              >
                {`Use ${e.name} · ${e.country} · #${e.id}`}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div>
        <Field
          label="Country"
          required
          hint={
            draft.country === '' && countryState === 'loading'
              ? "ISO code, e.g. EE — loading the organization's country…"
              : draft.country === '' && countryState === 'stale'
                ? "The organization's country as loaded earlier — it could not be refreshed; check it"
                : draft.country === '' && countryQ.data
                  ? "ISO code — the organization's country; change it if the counterparty is abroad"
                  : 'ISO code, e.g. EE'
          }
          error={
            draft.country === '' && countryState === 'error'
              ? `Couldn't load the organization's country — enter the ${w.one}'s country`
              : fieldError('country')
          }
        >
          <TextInput
            {...v.bind('country')}
            form={formId}
            value={effCountry}
            onChange={(e) => set('country', e.target.value.toUpperCase())}
            maxLength={2}
          />
        </Field>
        {draft.country === '' &&
          (countryState === 'error' || countryState === 'stale') && (
            <Button
              variant="secondary"
              className="mt-1.5 px-3 py-1.5 text-[13px]"
              onClick={() => void countryQ.refetch()}
            >
              Retry organization country
            </Button>
          )}
      </div>
      <Field
        label="Registration key"
        required
        hint={REG_KEY_HINT}
        error={fieldError('regKey')}
      >
        <TextInput
          {...v.bind('regKey')}
          form={formId}
          value={draft.regKey}
          onChange={(e) => set('regKey', e.target.value)}
        />
      </Field>
      <Field label="Goods or services">
        <SelectInput
          form={formId}
          value={draft.goods}
          onChange={(e) => set('goods', e.target.value as GoodsOrServices)}
        >
          {GOODS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="Tax status" hint={TAX_STATUS_HINT}>
        <SelectInput
          form={formId}
          value={draft.taxStatus}
          onChange={(e) => set('taxStatus', e.target.value as TaxStatus)}
        >
          {TAX_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectInput>
      </Field>
      {cp.createError !== null && (
        <p
          role="alert"
          className="rounded-xl bg-err-bg px-3 py-2 text-[12.5px] text-err"
        >
          {`Adding the ${w.one} was not confirmed (${cp.createError}). Your input is kept — search the list before adding it again, in case it was stored.`}
        </p>
      )}
      <Button className="w-full" busy={busy} type="submit" form={formId}>
        {`Add ${w.one}`}
      </Button>
      <div className="flex justify-between gap-3">
        <button
          type="button"
          onClick={cp.backToSearch}
          className="text-[13px] font-semibold text-accent"
        >
          Back to search
        </button>
        <button
          type="button"
          onClick={cp.discardDraft}
          className="text-[13px] font-semibold text-accent"
        >
          {`Discard new ${w.one}`}
        </button>
      </div>
    </div>
  );
}
