/**
 * The role the UI and the local repo may use right now.
 *
 * A server-confirmed branch is authoritative for its branch role. A cached
 * branch is stale authorisation: it is always presented as `assistant`, no
 * matter what the profile cache says. This one function keeps the shell, the
 * local repo and the POS from disagreeing about that rule.
 */

import type { Role } from '~/domain/types';

export type EffectiveRole = Role;

export function effectiveRole(
  source: 'server' | 'cache',
  branchRole: Role | null,
  sessionRole: Role | null,
  fallback: Role = 'assistant',
): Role {
  if (source === 'cache') return 'assistant';
  return branchRole ?? sessionRole ?? fallback;
}
