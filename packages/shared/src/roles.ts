// Roles are ordered: each role includes every permission of the roles before it.
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(actual: Role | null | undefined, required: Role): boolean {
  return actual != null && ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function minRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/** Environment tags drive safety policy (e.g. prod requires a reason for every write). */
export const ENVIRONMENTS = ['dev', 'test', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Browse keys, read values, run read-only commands, view metrics.',
  operator: 'Viewer + create/edit/delete keys, publish, run write commands.',
  admin: 'Operator + server administration (slowlog reset, client kill, profiler, FLUSHDB on non-prod), audit log and user management.',
};
