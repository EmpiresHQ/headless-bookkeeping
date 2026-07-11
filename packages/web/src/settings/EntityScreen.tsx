import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteEntity, type Entity } from '../api';
import { signedEuros } from '../lib/money';
import { useSheet } from '../lib/useSheet';
import {
  aliasesOf,
  classificationMemory,
  entityStats,
  identifierOf,
  invalidateEntities,
  ROLE_LABEL,
  ROLE_TONE,
  useEntityDetail,
} from '../queries/settings';
import { useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupLabel, KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { AddAliasSheet } from './AddAliasSheet';
import { EditEntitySheet } from './EditEntitySheet';

/** /settings/entities/:id — asset §8: identity + links + memory in one card. */
export function EntityScreen() {
  const { id: idParam } = useParams();
  const valid = idParam !== undefined && /^\d+$/.test(idParam);
  const id = valid ? Number(idParam) : 0;
  const entityQ = useEntityDetail(id, valid);

  if (!valid) {
    return (
      <Frame>
        <EmptyState icon="❓" title="This entity does not exist" />
      </Frame>
    );
  }
  if (entityQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  if (entityQ.isError) {
    return (
      <Frame>
        <LoadError
          message={
            entityQ.error instanceof Error ? entityQ.error.message : 'Failed'
          }
          onRetry={() => void entityQ.refetch()}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <EntityCard entity={entityQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Entity" backTo="/settings/entities" />
      {children}
    </div>
  );
}

function EntityCard({ entity }: { entity: Entity }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const edit = useSheet();
  const alias = useSheet();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();

  const regKey = identifierOf(entity, 'registration_key');
  const email = identifierOf(entity, 'email');
  const tg = identifierOf(entity, 'tg_user_id');
  const aliases = aliasesOf(entity);
  // Bookings row (P04 dishonest-transient rule): the relevant shared list
  // (expenses for a supplier, invoices for a customer) must have SETTLED
  // before entityStats runs — otherwise the `?? []` fallback below renders
  // a transient "Expenses · 0 / −0.00 €" while the list is still pending.
  const bookingsListReady =
    entity.role === 'supplier'
      ? expensesQ.data !== undefined
      : entity.role === 'customer'
        ? invoicesQ.data !== undefined
        : true;
  const stats = bookingsListReady
    ? entityStats(expensesQ.data ?? [], invoicesQ.data ?? [], entity)
    : null;
  const memory =
    entity.role === 'supplier'
      ? classificationMemory(expensesQ.data ?? [], entity.id)
      : null;

  const onDelete = async () => {
    setDeleting(true);
    try {
      await deleteEntity(entity.id);
      toastOk(`Deleted — ${entity.name}`);
      navigate('/settings/entities');
      void invalidateEntities(qc);
    } catch (e) {
      // The server's 409 sentence is already human (Reality #5).
      toastErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const bookingsQuery = `q=${encodeURIComponent(entity.name).replace(/%20/g, '+')}`;

  return (
    <>
      <div className="px-5 pb-3 pt-1 text-center">
        <p className="truncate text-[21px] font-extrabold">{entity.name}</p>
        <p className="mt-1 flex items-center justify-center gap-2 text-[13px] text-ink-2">
          <Chip tone={ROLE_TONE[entity.role]}>{ROLE_LABEL[entity.role]}</Chip>
          <span>
            {entity.country}
            {entity.goods_vs_services != null &&
            entity.goods_vs_services !== 'unknown'
              ? ` · ${entity.goods_vs_services}`
              : ''}
          </span>
        </p>
      </div>

      <ListGroup>
        {regKey !== null && <KeyValue k="Registration key" v={regKey} />}
        {email !== null && <KeyValue k="Email" v={email} />}
        {tg !== null && <KeyValue k="Telegram id" v={tg} />}
        {stats !== null && (
          <ListRow
            to={
              entity.role === 'supplier'
                ? `/books?seg=expenses&${bookingsQuery}`
                : `/books?seg=invoices&${bookingsQuery}`
            }
            title={`${stats.label} · ${stats.count}`}
            subtitle="Posted and pending — drafts not counted"
            trailing={
              <span className="whitespace-nowrap font-bold tabular-nums">
                {signedEuros(
                  entity.role === 'supplier'
                    ? -stats.totalCents
                    : stats.totalCents,
                )}
              </span>
            }
          />
        )}
      </ListGroup>
      {regKey !== null && (
        <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
          The registration key is the strong identity documents and bank lines
          match against — it cannot be changed.
        </p>
      )}
      {email !== null && (
        <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
          Identity fields are set at creation and are read-only here.
        </p>
      )}

      {entity.role !== 'employee' && entity.role !== 'director' && (
        <>
          <GroupLabel>Aliases — how documents name it</GroupLabel>
          <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-3.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {aliases.map((a) => (
                <Chip key={a.id} tone={a.confirmed ? 'muted' : 'warn'}>
                  {a.value}
                  {a.confirmed ? '' : ' · unconfirmed'}
                </Chip>
              ))}
              {aliases.length === 0 && (
                <span className="text-[12.5px] text-ink-2">
                  No aliases yet.
                </span>
              )}
              <button
                type="button"
                onClick={() => alias.open()}
                className="rounded-full bg-tint px-2 py-0.5 text-[10px] font-bold text-accent"
              >
                ＋ Add alias
              </button>
            </div>
          </div>
        </>
      )}

      {memory !== null && (
        <>
          <GroupLabel>Classification memory</GroupLabel>
          <ListGroup>
            <KeyValue
              k="Usually categorised"
              v={`${memory.category} (${memory.count} of ${memory.of})`}
            />
            <KeyValue k="Used as" v="AI hint, not a rule" />
          </ListGroup>
          <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
            Derived from this supplier's posted expenses — the same evidence the
            AI reads when suggesting a category.
          </p>
        </>
      )}

      <div className="mx-3.5 space-y-2.5">
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => edit.open()}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          className="w-full text-err"
          onClick={() => setDeleteOpen(true)}
        >
          Delete entity…
        </Button>
      </div>

      {edit.epoch > 0 && (
        <EditEntitySheet
          key={`edit-${entity.id}-${edit.epoch}`}
          entity={entity}
          open={edit.isOpen}
          onClose={edit.close}
        />
      )}
      {alias.epoch > 0 && (
        <AddAliasSheet
          key={`alias-${entity.id}-${alias.epoch}`}
          entityId={entity.id}
          open={alias.isOpen}
          onClose={alias.close}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => !deleting && setDeleteOpen(o)}
        title="Delete this entity?"
        body={`${entity.name} disappears from pickers and its aliases die with it. If any expense or invoice references it, the server refuses the deletion.`}
        confirmLabel="Delete entity"
        destructive
        busy={deleting}
        onConfirm={() => void onDelete()}
      />
    </>
  );
}
