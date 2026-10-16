/**
 * Platform overview.
 *
 * Every figure here is counted from `pf_platform_pharmacies`, which is scoped to
 * platform administrators by a predicate inside the view. Nothing is estimated,
 * and nothing is filled in from the local store: this screen describes the
 * platform, not the browser.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Building2, CircleCheck, CirclePause, Clock, Users } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { StatTile } from '~/components/app/primitives';
import {
  listActivity,
  listPharmacies,
  type PlatformActivity,
  type PlatformPharmacy,
} from '~/lib/supabase/platform';

export const Route = createFileRoute('/platform/')({
  component: PlatformOverview,
});

type Status = 'pending' | 'active' | 'suspended';

function countBy(rows: PlatformPharmacy[], status: Status): number {
  return rows.filter((p) => p.status === status).length;
}

function PlatformOverview() {
  const [pharmacies, setPharmacies] = useState<PlatformPharmacy[] | null>(null);
  const [activity, setActivity] = useState<PlatformActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // One page of 200 is enough to count the statuses. The counts are of
      // pharmacies, not of rows the operator has to scroll through, and the
      // list screen pages properly for the detail work.
      const [page, recent] = await Promise.all([listPharmacies(200, 0), listActivity(8)]);
      if (cancelled) return;
      if (!page.ok) {
        setError(page.error);
        return;
      }
      setPharmacies(page.data.rows);
      setActivity(recent.ok ? recent.data : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    if (!pharmacies) return null;
    const owners = pharmacies.filter((p) => p.owner_name).length;
    const people = pharmacies.reduce((sum, p) => sum + (p.member_count ?? 0), 0);
    const awaiting = pharmacies.filter((p) => p.status === 'pending').length;
    return {
      all: pharmacies.length,
      active: countBy(pharmacies, 'active'),
      pending: countBy(pharmacies, 'pending'),
      suspended: countBy(pharmacies, 'suspended'),
      owners,
      people,
      awaiting,
    };
  }, [pharmacies]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Could not load the platform overview</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-destructive">{error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Platform overview</h1>
          <p className="text-sm text-muted-foreground">
            Every pharmacy registered on PharmaFlow.
          </p>
        </div>
        <Button render={<Link to="/platform/pharmacies" />}>
          <Building2 className="size-4" />
          Manage pharmacies
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Registered pharmacies"
          value={totals ? totals.all : '?'}
          hint={totals ? `${totals.owners} with a named owner` : 'loading'}
          icon={<Building2 className="size-4" />}
        />
        <StatTile
          label="Active"
          value={totals ? totals.active : '?'}
          hint="owners can sign in and trade"
          icon={<CircleCheck className="size-4" />}
          tone={totals && totals.active > 0 ? 'positive' : 'neutral'}
        />
        <StatTile
          label="Awaiting onboarding"
          value={totals ? totals.awaiting : '?'}
          hint={
            totals && totals.awaiting > 0
              ? 'invitation not yet accepted'
              : 'no invitations outstanding'
          }
          icon={<Clock className="size-4" />}
          tone={totals && totals.awaiting > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Suspended"
          value={totals ? totals.suspended : '?'}
          hint="access withdrawn, records kept"
          icon={<CirclePause className="size-4" />}
          tone={totals && totals.suspended > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Owners and staff"
          value={totals ? totals.people : '?'}
          hint={totals ? `across ${totals.owners} pharmacy pharmacies` : 'loading'}
          icon={<Users className="size-4" />}
        />
        <StatTile
          label="Failed onboarding"
          value="Not tracked"
          hint="see Platform Administration for why"
          icon={<Clock className="size-4" />}
        />
      </div>

      {/* Deliberately absent: a platform-wide order count and a revenue figure.
          The customer-order workflow writes to localStorage, so there is nothing
          in the database to count, and a `0` here would be a false claim rather
          than an honest empty state. The Orders tab says this in words. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Recent platform activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No recorded activity yet.
            </p>
          ) : (
            <ul className="divide-y">
              {activity.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{event.description}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {event.pharmacy_name}
                      {event.actor_name ? ` ? ${event.actor_name}` : ''}
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {event.action}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}