import { Api } from './api.ts';

export const ROLE_KEYS = ['anon', 'viewer', 'operator', 'admin'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** One API session per role (stored sessions from the setup project; anon has no cookie). */
export async function roleApis(): Promise<Record<RoleKey, Api>> {
  return {
    anon: await Api.anonymous(),
    viewer: await Api.fromStorage('viewer'),
    operator: await Api.fromStorage('operator'),
    admin: await Api.fromStorage('admin'),
  };
}

export async function disposeAll(apis: Partial<Record<string, Api>>): Promise<void> {
  for (const a of Object.values(apis)) await a?.dispose();
}
