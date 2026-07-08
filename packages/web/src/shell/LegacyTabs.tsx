import type { ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SegmentedControl } from '../ui/SegmentedControl';
import { LargeTitleHeader } from './Headers';

export interface LegacyTab {
  key: string;
  label: string;
  El: ComponentType;
}

/**
 * Transitional adapter: hosts untouched legacy View components inside the new
 * shell, one section = one URL, active sub-view in ?tab=. Dies with the last
 * legacy view (Plan 06).
 */
export function LegacyTabs({
  title,
  tabs,
}: {
  title: string;
  tabs: LegacyTab[];
}) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((t) => t.key === params.get('tab')) ?? tabs[0];
  const El = active.El;
  return (
    <div className="mx-auto max-w-5xl">
      <LargeTitleHeader title={title} />
      {tabs.length > 1 && (
        <div className="px-4 pb-3">
          <SegmentedControl
            options={tabs.map((t) => ({ value: t.key, label: t.label }))}
            value={active.key}
            onChange={(v) => setParams({ tab: v }, { replace: true })}
          />
        </div>
      )}
      <div className="mx-4 mb-6 rounded-2xl bg-surface p-3 shadow-sm">
        <El />
      </div>
    </div>
  );
}
