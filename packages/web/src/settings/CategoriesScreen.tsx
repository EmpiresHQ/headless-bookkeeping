import { useCategories } from '../queries/shared';
import { useOrganization } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';

/**
 * /settings/categories — READ-ONLY reference (spec: plugin-owned). Rows are
 * label + key; the key is legitimate operator vocabulary (it is the
 * `category` value on every expense). CategoryDef.accountCode NEVER renders
 * (Reality #7 — ADR-0001/0030; the legacy "Account" column dies with
 * CategoriesView).
 */
export function CategoriesScreen() {
  const categoriesQ = useCategories();
  const orgQ = useOrganization();
  const country = orgQ.data?.country ?? 'country';
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Categories" backTo="/settings" />
      <p className="mx-6 mb-3 text-[12.5px] text-ink-2">
        Defined by the {country} country plugin — read-only. The AI and the
        classify forms pick from this list; each expense carries one of these
        keys as its category.
      </p>
      {categoriesQ.isPending ? (
        <SkeletonRows count={5} />
      ) : categoriesQ.isError ? (
        <LoadError
          message={
            categoriesQ.error instanceof Error
              ? categoriesQ.error.message
              : 'Failed to load categories'
          }
          onRetry={() => void categoriesQ.refetch()}
        />
      ) : categoriesQ.data.length === 0 ? (
        <EmptyState
          icon="🏷"
          title="No categories"
          hint="The active country plugin defines none — check the organization country."
        />
      ) : (
        <ListGroup>
          {categoriesQ.data.map((c) => (
            <ListRow key={c.key} title={c.label} subtitle={c.key} />
          ))}
        </ListGroup>
      )}
    </div>
  );
}
