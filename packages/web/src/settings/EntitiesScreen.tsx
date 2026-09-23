import { useSearchParams } from 'react-router-dom';
import { useSeg } from '../lib/useSeg';
import { useSheet } from '../lib/useSheet';
import {
  ALL_SEGMENT_ROLE_HINT,
  ENTITY_SEGMENTS,
  entityMatchesQuery,
  ROLE_LABEL,
  ROLE_TONE,
  SEGMENT_DEFAULT_ROLE,
  segmentEntities,
  type EntitySegment,
} from '../queries/settings';
import { useEntities } from '../queries/shared';
import { LargeTitleHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CreateEntitySheet } from './CreateEntitySheet';

/** /settings/entities — asset §8 list: name + role chip + country, search,
 *  role segments incl. Team (= ADR-0036 claimants). No ids on screen. */
export function EntitiesScreen() {
  const [seg, setSeg] = useSeg<EntitySegment>(ENTITY_SEGMENTS, 'all');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  // The segment is captured as the sheet payload AT OPEN TIME (issue #264):
  // each open (epoch-keyed remount) starts from the role of the segment it
  // was opened on, never from a live/previous segment.
  const create = useSheet<EntitySegment>();
  const openCreate = () => create.open(seg);
  const openedFrom = create.payload ?? 'all';
  const entitiesQ = useEntities();

  const setQ = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === '') p.delete('q');
    else p.set('q', next);
    setParams(p, { replace: true });
  };

  const rows = segmentEntities(entitiesQ.data ?? [], seg).filter((e) =>
    entityMatchesQuery(e, q),
  );

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Entities"
        trailing={
          <Button variant="secondary" onClick={openCreate}>
            ＋ Add
          </Button>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          label="Entity role"
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'suppliers' as const, label: 'Suppliers' },
            { value: 'customers' as const, label: 'Customers' },
            { value: 'team' as const, label: 'Team' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Search entities"
          aria-label="Search entities"
        />
      </div>
      {entitiesQ.isPending ? (
        <SkeletonRows count={4} />
      ) : entitiesQ.isError ? (
        <LoadError
          message={
            entitiesQ.error instanceof Error
              ? entitiesQ.error.message
              : 'Failed to load entities'
          }
          onRetry={() => void entitiesQ.refetch()}
        />
      ) : rows.length === 0 ? (
        seg === 'team' && q === '' ? (
          <EmptyState
            icon="👥"
            title="No team members yet"
            hint="Add an employee or director so they appear in the claimant dropdown when a receipt is uploaded for reimbursement (who paid — reimburse them)."
            action={<Button onClick={openCreate}>Add employee</Button>}
          />
        ) : (
          <EmptyState
            icon="👥"
            title={
              q !== '' || seg !== 'all' ? 'Nothing matches' : 'No entities yet'
            }
            hint={
              q !== '' || seg !== 'all'
                ? 'Try another segment or search term.'
                : 'Suppliers and customers are created automatically when documents and bank lines are booked; employees and directors (reimbursement claimants) are added here.'
            }
            action={<Button onClick={openCreate}>Add entity</Button>}
          />
        )
      ) : (
        <ListGroup>
          {rows.map((e) => (
            <ListRow
              key={e.id}
              to={`/settings/entities/${e.id}`}
              title={e.name}
              subtitle={e.country}
              chip={<Chip tone={ROLE_TONE[e.role]}>{ROLE_LABEL[e.role]}</Chip>}
            />
          ))}
        </ListGroup>
      )}
      {create.epoch > 0 && (
        <CreateEntitySheet
          key={create.epoch}
          open={create.isOpen}
          onClose={create.close}
          defaultRole={SEGMENT_DEFAULT_ROLE[openedFrom]}
          roleHint={openedFrom === 'all' ? ALL_SEGMENT_ROLE_HINT : undefined}
        />
      )}
    </div>
  );
}
