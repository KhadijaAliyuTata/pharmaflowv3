/**
 * The role the UI and the local repo may use right now.
 *
 * A server-confirmed branch is authoritative for its branch role. A cached
 * branch is stale authorisation: it is always presented as `assistant`, no
 * matter what the profile cache says. This one function keeps the shell, the
 * local repo and the POS from disagreeing about that rule.
 */

export type EffectiveRole = 'owner' | 'assistant';

export function effectiveRole(
  source: 'server' | 'cache',
  branchRole: EffectiveRole | null,
  sessionRole: EffectiveRole | null,
  fallback: EffectiveRole = 'assistant',
): EffectiveRole {
  if (source === 'cache') return 'assistant';
  return branchRole ?? sessionRole ?? fallback;
}
