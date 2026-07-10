import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  onboardEntity,
  type EntityRole,
  type OnboardEntityInput,
} from '../api';
import { invalidateEntities, ROLE_LABEL } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

const ROLES: readonly EntityRole[] = [
  'supplier',
  'customer',
  'employee',
  'director',
];
const NEEDS_REG_KEY: readonly EntityRole[] = ['supplier', 'customer'];

/**
 * Onboarding sheet — all FOUR server roles (Reality #4; the legacy view
 * offered two, which starved the ADR-0036 claimant dropdown). Identity is
 * per-role: supplier/customer → registration key (immutable, the strong
 * match identity); employee/director → email (+ optional Telegram id).
 * Payload assembly is CONDITIONED on role, not on which fields happen to
 * hold stale values — switching role mid-form can never leak a
 * supplier-typed registrationKey onto an employee payload.
 */
export function CreateEntitySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<EntityRole>('supplier');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [goods, setGoods] = useState<'goods' | 'services' | 'unknown'>(
    'unknown',
  );
  const [email, setEmail] = useState('');
  const [tgUserId, setTgUserId] = useState('');

  const needsRegKey = NEEDS_REG_KEY.includes(role);
  const valid =
    name.trim() !== '' &&
    country.trim() !== '' &&
    (needsRegKey ? regKey.trim() !== '' : email.trim() !== '');

  const submit = async () => {
    setBusy(true);
    try {
      const input: OnboardEntityInput = needsRegKey
        ? {
            role,
            name: name.trim(),
            country: country.trim().toUpperCase(),
            registrationKey: regKey.trim(),
            goodsVsServices: goods,
          }
        : {
            role,
            name: name.trim(),
            country: country.trim().toUpperCase(),
            email: email.trim(),
            ...(tgUserId.trim() !== '' ? { tgUserId: tgUserId.trim() } : {}),
          };
      const created = await onboardEntity(input);
      toastOk(`${ROLE_LABEL[role]} added — ${name.trim()}`);
      onClose();
      navigate(`/settings/entities/${created.id}`);
      void invalidateEntities(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // Refuse to dismiss while the onboard mutation is in flight: vaul's
  // backdrop/swipe dismissal would otherwise unmount this component mid-
  // request, losing the success navigate + receipt toast (the P05 lesson —
  // same guard as LockSheet's guardedOnOpenChange).
  const guardedOnOpenChange = (o: boolean) => {
    if (busy && !o) return;
    if (!o) onClose();
  };

  return (
    <Sheet open={open} onOpenChange={guardedOnOpenChange} title="Add entity">
      <div className="space-y-4 px-6 pb-2">
        <Field label="Role">
          <SelectInput
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as EntityRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectInput>
        </Field>
        {!needsRegKey && (
          <p className="text-[12.5px] text-ink-2">
            Appears in the claimant dropdown when uploading a receipt
            (reimbursement)
          </p>
        )}
        <Field label="Name">
          <TextInput
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              needsRegKey ? 'e.g. Circle K Eesti AS' : 'e.g. Mari Maasikas'
            }
          />
        </Field>
        <Field label="Country">
          <TextInput
            aria-label="Country"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            placeholder="EE"
            maxLength={2}
          />
        </Field>
        {needsRegKey ? (
          <>
            <Field
              label="Registration key"
              hint="Registry or VAT number — the strong identity that matches documents and bank lines. Cannot be changed later."
            >
              <TextInput
                aria-label="Registration key"
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
                placeholder="e.g. EE100511246"
              />
            </Field>
            <Field label="Goods or services">
              <SelectInput
                aria-label="Goods or services"
                value={goods}
                onChange={(e) =>
                  setGoods(e.target.value as 'goods' | 'services' | 'unknown')
                }
              >
                <option value="unknown">Unknown</option>
                <option value="goods">Goods</option>
                <option value="services">Services</option>
              </SelectInput>
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Email"
              hint="Identity for reimbursement and channel matching"
            >
              <TextInput
                aria-label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="mari@example.com"
              />
            </Field>
            <Field
              label="Telegram user id"
              hint="Optional — links their Telegram messages"
            >
              <TextInput
                aria-label="Telegram user id"
                value={tgUserId}
                onChange={(e) => setTgUserId(e.target.value)}
                placeholder="123456789"
              />
            </Field>
          </>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          {`Add ${ROLE_LABEL[role].toLowerCase()}`}
        </Button>
      </div>
    </Sheet>
  );
}
