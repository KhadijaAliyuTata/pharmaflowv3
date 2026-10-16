/**
 * Platform activity ? read-only.
 *
 * Reads `pf_platform_activity`, which is `audit_events` joined to the pharmacy
 * name and gated by `pf_is_platform_admin()` inside the view.
 *
 * Deliberately excludes `metadata`. It is free-form jsonb that a future writer
 * could put anything into, and an activity feed does not need it. Nothing here
 * is ever logged, and no invitation token or password appears: the underlying
 * rows never contain one.
 */

import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { formatRelative } from '~/domain/money';
import { listActivity, type PlatformActivity } from '~/lib/supabase/platform';

export const Route = createFileRoute('/platform/activity')({
  component: PlatformActivityFeed,
});

function PlatformActivityFeed() {
  const [rows, setRows] = useState<PlatformActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listActivity();
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Platform activity</h1>
        <p className="text-sm text-muted-foreground">
          Recorded events across every pharmacy. Read-only.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading?</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No activity has been recorded yet.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm">{event.description}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {event.pharmacy_name}
                      {event.actor_name ? ` ? ${event.actor_name}` : ''} ?{' '}
                      {formatRelative(event.created_at)}
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