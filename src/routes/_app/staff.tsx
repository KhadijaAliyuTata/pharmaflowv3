import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BadgeCheck, Filter, ShieldAlert, Stethoscope, Users } from 'lucide-react';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { PageHeader, SectionTitle, StatTile } from '~/components/app/primitives';
import { formatRelative } from '~/domain/money';
import { ACTION_LABEL, ACTION_TONE } from '~/domain/audit-labels';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/staff')({
  // A staff search result lands here focused on that person: `?q=` is matched
  // against the team, and an exact name match seeds the audit log's actor
  // filter — which is the "what did they do" view of the same person.
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: StaffScreen,
});

const ALL = 'all';

// ACTION_LABEL and ACTION_TONE moved to `~/domain/audit-labels` so this screen
// and the owner dashboard's activity ledger cannot drift apart.

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function StaffScreen() {
  const users = usePharmacy((state) => state.users);
  const events = usePharmacy((state) => state.auditEvents);
  const currentUser = usePharmacy((state) => state.currentUser);
  const { role } = useCurrentUser();

  const { q } = Route.useSearch();

  // `?q=` only pre-selects an actor when it names someone on the team exactly.
  // A partial term must not silently narrow the audit log to nothing, so
  // anything that is not a known name leaves the filter on "All Staff".
  const [actor, setActor] = useState(() => {
    if (!q) return ALL;
    const match = users.find((user) => user.name.toLowerCase() === q.trim().toLowerCase());
    return match ? match.name : ALL;
  });
  const [action, setAction] = useState(ALL);

  // Re-focus when a second search arrives from the header while this screen is
  // already open, otherwise the new `?q=` would look like it did nothing.
  useEffect(() => {
    if (!q) {
      setActor(ALL);
      return;
    }
    const match = users.find((user) => user.name.toLowerCase() === q.trim().toLowerCase());
    setActor(match ? match.name : ALL);
  }, [q, users]);

  // v2 stored the audit array twice, under auditLogs and auditEvents. One source.
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (actor === ALL || event.actorName === actor) &&
          (action === ALL || event.action === action),
      ),
    [events, actor, action],
  );

  const actions = useMemo(() => Array.from(new Set(events.map((e) => e.action))), [events]);

  if (role !== 'owner') {
    return (
      <div className="space-y-6">
        <PageHeader title="Staff & Audit" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlert />
            </EmptyMedia>
            <EmptyTitle>Not available for your role</EmptyTitle>
            <EmptyDescription>
              Staff records and the audit log are owner-only. Switch to the owner account to
              see them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff & Audit"
        description="Who works here, and what they did."
        meta={
          <p className="text-xs text-muted-foreground">
            Read only. Inviting staff or changing permissions is not wired up.
          </p>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Team"
          value={users.length}
          hint={`${users.filter((u) => u.role === 'owner').length} owner · ${users.filter((u) => u.role === 'assistant').length} assistant`}
          icon={<Users className="size-4" />}
        />
        <StatTile
          label="Can approve pricing"
          value={users.filter((u) => u.canApprovePricing).length}
          hint="The only path that prices incoming stock"
          icon={<BadgeCheck className="size-4" />}
        />
        <StatTile
          label="Audit events"
          value={events.length}
          hint={`${filtered.length} shown after filters`}
          icon={<Stethoscope className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <SectionTitle>Team</SectionTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {users.map((user) => (
              <li key={user.id} className="flex flex-wrap items-start gap-3 py-3">
                <Avatar>
                  <AvatarFallback>{initials(user.name)}</AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{user.name}</p>
                    <Badge variant={user.role === 'owner' ? 'default' : 'secondary'}>
                      {user.role === 'owner' ? 'Owner' : 'Assistant'}
                    </Badge>
                    {user.id === currentUser.id && <Badge variant="outline">Signed in</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {user.email} · {user.phone}
                  </p>
                  {user.licenseNumber && (
                    <p data-numeric className="tabular text-xs text-muted-foreground">
                      PCN {user.licenseNumber}
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  {user.canApprovePricing ? (
                    <Badge variant="success">Approves pricing</Badge>
                  ) : (
                    <Badge variant="outline">Requests pricing</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>Audit log</SectionTitle>

            <div className="flex flex-wrap items-center gap-2">
              <Filter className="size-4 shrink-0 text-muted-foreground" />
              <Select value={actor} onValueChange={(value) => setActor(value ?? ALL)}>
                <SelectTrigger size="sm" aria-label="Filter by actor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Everyone</SelectItem>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.name}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={action} onValueChange={(value) => setAction(value ?? ALL)}>
                <SelectTrigger size="sm" aria-label="Filter by action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All actions</SelectItem>
                  {actions.map((item) => (
                    <SelectItem key={item} value={item}>
                      {ACTION_LABEL[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No audit events match those filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(event.timestamp)}
                    </TableCell>
                    <TableCell className="font-medium">{event.actorName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {event.actorRole === 'owner' ? 'Owner' : 'Assistant'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ACTION_TONE[event.action]}>
                        {ACTION_LABEL[event.action]}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-96 whitespace-normal">
                      {event.description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
