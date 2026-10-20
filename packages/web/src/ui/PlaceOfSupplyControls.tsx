import { Field, SelectInput, TextInput } from './Form';
import type { ServicePlaceRule } from '../api';

/** The place-of-supply rules a manual form can CHOOSE (issue #403): the
 *  residual general rule plus the two implemented local-consumption
 *  exceptions. Rules the kernel does not implement cannot be chosen here —
 *  only PRESERVED when already recorded (see PlaceOfSupplyControls). */
export const PLACE_RULE_OPTIONS = [
  { value: '', label: 'General (default)' },
  {
    value: 'immovable_property',
    label: 'Accommodation — immovable property (Art 47)',
  },
  { value: 'restaurant_catering', label: 'Restaurant & catering (Art 55)' },
] as const;

/** An operator-typed country, normalized to the ISO form the server takes. */
export const normalizePlaceCountry = (v: string) => v.trim().toUpperCase();

/**
 * The place-of-supply declaration to SEND (issue #403): the chosen
 * local-consumption exception, or 'general' — the server's EXPLICIT CLEAR —
 * so a form submitted on the general choice never silently keeps an obsolete
 * local classification.
 *
 * A RECORDED rule the select does not offer (an unimplemented special rule,
 * e.g. passenger_transport) is PRESERVED untouched unless the operator
 * explicitly selects General: silently re-declaring it as 'general' would
 * enable a general-rule reverse charge the stored declaration contradicts.
 * Untouched means the select still shows the recorded rule; an EMPTY value
 * is only an explicit 'General' selection (or no recorded rule at all), and
 * BOTH mean 'general'.
 */
export function declaredPlaceRule(
  placeRule: string,
  storedRule: ServicePlaceRule | null | undefined,
): ServicePlaceRule {
  const untouched =
    storedRule != null && storedRule !== 'general' && placeRule === storedRule;
  if (untouched) return storedRule;
  return placeRule === 'immovable_property'
    ? 'immovable_property'
    : placeRule === 'restaurant_catering'
      ? 'restaurant_catering'
      : 'general';
}

/**
 * The shared place-of-supply control pair (issue #403): the rule select plus
 * the recorded-supply-country input. Used by the expense draft editor AND
 * the manual-classify sheet, so both offer exactly the same choices, the
 * same explicit-clear semantics and the same preserve-a-recorded-special-
 * rule behaviour.
 *
 * `storedRule` is the RECORDED declaration an untouched form must keep
 * visible (an unsupported special rule renders as its own option, marked
 * kept — never silently swapped for another choice).
 */
export function PlaceOfSupplyControls({
  placeRule,
  onPlaceRuleChange,
  placeCountry,
  onPlaceCountryChange,
  storedRule,
}: {
  placeRule: string;
  onPlaceRuleChange: (value: string) => void;
  placeCountry: string;
  onPlaceCountryChange: (value: string) => void;
  storedRule: ServicePlaceRule | null | undefined;
}) {
  const incomplete =
    placeRule !== '' && placeCountry.trim() === ''
      ? 'Enter the country the supply took place in (e.g. DK)'
      : null;
  const storedSpecial =
    storedRule != null &&
    storedRule !== 'general' &&
    storedRule !== 'immovable_property' &&
    storedRule !== 'restaurant_catering';
  return (
    <div className="flex gap-2.5">
      <div className="flex-1">
        <Field
          label="Place-of-supply rule"
          hint="declare only for local foreign purchases (e.g. a hotel or a restaurant bill)"
        >
          <SelectInput
            aria-label="Place-of-supply rule"
            value={placeRule}
            onChange={(e) => onPlaceRuleChange(e.target.value)}
          >
            {PLACE_RULE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {/* A recorded rule the select does not offer stays VISIBLE and
                actionable — never silently swapped for another choice. */}
            {storedSpecial && (
              <option value={storedRule}>{storedRule} (recorded — kept)</option>
            )}
          </SelectInput>
        </Field>
      </div>
      <div className="flex-1">
        <Field
          label="Supplied in country"
          hint="ISO code where the supply physically took place"
          error={incomplete}
        >
          <TextInput
            aria-label="Supplied in country"
            value={placeCountry}
            onChange={(e) => onPlaceCountryChange(e.target.value)}
            placeholder={placeRule === '' ? '—' : 'DK'}
            disabled={placeRule === ''}
          />
        </Field>
      </div>
    </div>
  );
}
