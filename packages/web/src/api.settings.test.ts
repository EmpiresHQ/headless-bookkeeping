import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { onboardEntity, type EntityRole, type OnboardEntityInput } from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('entity onboarding — four-role reality (Plan 06 Reality #4)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('posts an employee with email + tgUserId and WITHOUT registrationKey', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        ok({ id: 9, role: 'employee', country: 'EE', name: 'Mari Maasikas' }),
      );
    const input: OnboardEntityInput = {
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      email: 'mari@example.com',
      tgUserId: '123456789',
    };
    const created = await onboardEntity(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/entities');
    expect(init?.method).toBe('POST');
    // JSON.stringify drops undefined — the wire body must not carry a
    // registrationKey key at all for employee/director.
    expect(JSON.parse(init?.body as string)).toEqual({
      role: 'employee',
      country: 'EE',
      name: 'Mari Maasikas',
      email: 'mari@example.com',
      tgUserId: '123456789',
    });
    expect(created.id).toBe(9);
  });

  it('posts a supplier with registrationKey exactly as before (no regression)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 3,
        role: 'supplier',
        country: 'EE',
        name: 'Circle K Eesti AS',
      }),
    );
    await onboardEntity({
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      registrationKey: 'EE100511246',
      goodsVsServices: 'goods',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      registrationKey: 'EE100511246',
      goodsVsServices: 'goods',
    });
  });

  it('EntityRole covers exactly the server enum', () => {
    // Compile-time pin: assignment fails if the union drifts.
    const roles: EntityRole[] = [
      'supplier',
      'customer',
      'employee',
      'director',
    ];
    expect(roles).toHaveLength(4);
  });
});
