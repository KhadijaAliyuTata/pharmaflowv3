import { Building2, MapPin, ShieldCheck } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import type { Branch } from '~/domain/state';
import type { User } from '~/domain/types';

/**
 * The pharmacy-specific header at the top of the owner dashboard.
 *
 * ## Where the numbers come from
 *
 * Pharmacy name is the branch's own name. Premises number and PCN number are
 * branch registration fields, added by migration 20261005160000 and nullable.
 * They are **not** on `User.licenseNumber`, which is a staff member's personal
 * licence: showing a person's licence as the pharmacy's registration would
 * change the number depending on who signed in, which is worse on a compliance
 * surface than showing nothing.
 *
 * ## "Not set" is the correct answer
 *
 * No branch has either number configured, so this renders "Not set". That is the
 * intended empty state, not a placeholder to be papered over — an invented PCN
 * number on a pharmacy dashboard is a fabrication of a regulatory fact. The
 * `notSet` variant is styled muted rather than hidden so its absence is visible
 * and can be acted on, instead of the row silently not existing.
 *
 * The greeting reads the signed-in user's name. It is not hard-coded, and it is
 * not the seed owner's name: a different user signing in sees their own.
 */

/** "Good morning" / "Good afternoon" / "Good evening" from the local clock. */
export function greeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** A registration field that may legitimately be unconfigured. */
function RegistrationNumber({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  const configured = typeof value === 'string' && value.trim() !== '';

  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        data-numeric={configured ? '' : undefined}
        className={
          configured
            ? 'truncate text-sm font-medium text-foreground'
            : 'text-sm font-medium text-muted-foreground italic'
        }
      >
        {/* The label is always shown, so "Not set" reads as a value of the
            named field rather than as a missing row. */}
        {configured ? value.trim() : `Not set`}
      </dd>
    </div>
  );
}

export function OwnerHeader({
  branch,
  user,
  className,
}: {
  branch: Branch;
  user: User;
  className?: string;
}) {
  return (
    <section
      className={
        className ??
        'rounded-xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5'
      }
    >
      {/* Pharmacy name leads, in the navy heading colour used across the app. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Building2 className="size-3.5 shrink-0" />
            Pharmacy
          </p>
          <h1 className="truncate font-heading text-xl font-semibold tracking-tight text-heading sm:text-2xl">
            {branch.name}
          </h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">
              {branch.address}, {branch.city}, {branch.state}
            </span>
          </p>
        </div>

        <Badge variant="outline" className="shrink-0 gap-1">
          <ShieldCheck className="size-3" />
          {user.role === 'owner' ? 'Owner' : 'Pharmacist / attendant'}
        </Badge>
      </div>

      {/* Registration numbers. A dl, so the label/value pairing is announced
          as such rather than as two loose strings. */}
      <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2">
        <RegistrationNumber label="Premises Number" value={branch.premisesNumber} />
        <RegistrationNumber label="PCN Number" value={branch.pcnNumber} />
      </dl>

      {/* Greeting last in this block, below the identity of the pharmacy: it is
          the personal half of the header. */}
      <p className="mt-4 text-sm text-muted-foreground">
        {greeting()},{' '}
        <span className="font-medium text-foreground">{user.name}</span>
      </p>
    </section>
  );
}
