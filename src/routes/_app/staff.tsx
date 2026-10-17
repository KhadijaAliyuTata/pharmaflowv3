import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  BadgeCheck,
  Check,
  Copy,
  Filter,
  LinkIcon,
  ShieldAlert,
  Stethoscope,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
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
import type { StaffRole } from '~/lib/db.types';
import { invitationLink } from '~/lib/join-link';
import { useAuditEvents } from '~/hooks/use-audit-events';
import { useIsOwner } from '~/hooks/use-is-owner';
import { useStaff } from '~/hooks/use-staff';
import { usePharmacy } from '~/store/pharmacy';

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
  const { events, loading: auditLoading, error: auditError } = useAuditEvents();
  const currentUser = usePharmacy((state) => state.currentUser);

  // Authoritative: `pf_is_owner()` resolves `branch_memberships.role`. The old
  // check read `state.currentUser.role`, which is `profiles.role` - a display
  // cache that a demotion never repairs, so it could keep offering this screen
  // to somebody the database had already demoted.
  const isOwner = useIsOwner() === true;
  const staff = useStaff(isOwner);
  const { members, invitations, canManage } = staff;

  const { q } = Route.useSearch();

  // `?q=` only pre-selects an actor when it names someone on the team exactly.
  // A partial term must not silently narrow the audit log to nothing, so
  // anything that is not a known name leaves the filter on "All Staff".
  const [actor, setActor] = useState(() => {
    if (!q) return ALL;
    const match = members.find((user) => user.fullName.toLowerCase() === q.trim().toLowerCase());
    return match ? match.fullName : ALL;
  });
  const [action, setAction] = useState(ALL);

  // Re-focus when a second search arrives from the header while this screen is
  // already open, otherwise the new `?q=` would look like it did nothing.
  useEffect(() => {
    if (!q) {
      setActor(ALL);
      return;
    }
    const match = members.find((user) => user.fullName.toLowerCase() === q.trim().toLowerCase());
    setActor(match ? match.fullName : ALL);
  }, [q, members]);

  // v2 stored the audit array twice, under auditLogs and auditEvents. One source.
  //
  // The audit log now comes from `audit_events` in live mode (`useAuditEvents`)
  // and the seeded array in demo mode, so the seam this comment used to name —
  // a store log beside a Supabase team — is closed. The actor filter still
  // matches on display name: the log embeds the actor's profile, but the two
  // lists are not joined by id, exactly as before.
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

  if (!isOwner) {
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
          canManage ? (
            <InviteDialog onInvite={staff.invite} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Read only. Demo mode has no accounts to create or remove.
            </p>
          )
        }
      />

      {/*
        A failed read has to be visible. Falling back to the seeded team here would
        be a lie about who has access to a real pharmacy, so an error replaces the
        list rather than sitting quietly behind it.
      */}
      {staff.error && (
        <p className="rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning">
          {staff.error}
        </p>
      )}

      {staff.notice && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          {staff.notice}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Team"
          value={members.length}
          hint={`${members.filter((u) => u.role === 'owner').length} owner · ${members.filter((u) => u.role === 'assistant').length} assistant`}
          icon={<Users className="size-4" />}
        />
        <StatTile
          label="Owners"
          value={members.filter((u) => u.role === 'owner').length}
          hint="Only an owner approves incoming stock pricing"
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
          {members.length === 0 && !staff.loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nobody is on the team for this branch yet.
            </p>
          ) : (
            <ul className="divide-y">
              {members.map((user) => (
                <li key={user.userId} className="flex flex-wrap items-start gap-3 py-3">
                  <Avatar>
                    <AvatarFallback>{initials(user.fullName)}</AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{user.fullName}</p>
                      <Badge variant={user.role === 'owner' ? 'default' : 'secondary'}>
                        {user.role === 'owner' ? 'Owner' : 'Assistant'}
                      </Badge>
                      {user.userId === currentUser.id && <Badge variant="outline">Signed in</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {user.phone ?? 'No phone on record'}
                    </p>
                    {user.licenseNumber && (
                      <p data-numeric className="tabular text-xs text-muted-foreground">
                        PCN {user.licenseNumber}
                      </p>
                    )}
                  </div>

                  {/*
                    The last owner is never offered the button. Removing them
                    would leave a branch that nobody can approve a price for, and
                    it is a dead end that is much easier to avoid than to recover
                    from - `pf_current_role()` would return NULL for everyone.
                  */}
                  {canManage && !isLastOwner(members, user.userId, currentUser.id) && (
                    <RemoveMemberButton
                      userId={user.userId}
                      name={user.fullName}
                      onRemove={staff.remove}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <SectionTitle>Invitations</SectionTitle>
          </CardHeader>
          <CardContent>
            {invitations.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No invitations yet. Add someone above to get a code to share.
              </p>
            ) : (
              <ul className="divide-y">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{invitation.email}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {invitation.role === 'owner' ? 'Owner' : 'Assistant'} ·{' '}
                        {formatRelative(invitation.createdAt)}
                      </p>
                    </div>

                    <Badge
                      variant={
                        invitation.status === 'pending'
                          ? 'secondary'
                          : invitation.status === 'accepted'
                            ? 'success'
                            : 'outline'
                      }
                    >
                      {invitation.status === 'pending'
                        ? 'Waiting'
                        : invitation.status === 'accepted'
                          ? 'Joined'
                          : 'Withdrawn'}
                    </Badge>

                    {invitation.status === 'pending' && (
                      <>
                        <CopyToken token={invitation.token} />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void staff.revoke(invitation.token)}
                        >
                          <X className="size-4" />
                          Withdraw
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

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
                  {members.map((user) => (
                    <SelectItem key={user.userId} value={user.fullName}>
                      {user.fullName}
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
          {auditError ? (
            <p role="alert" className="py-8 text-center text-sm text-muted-foreground">
              {auditError}
            </p>
          ) : auditLoading && events.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading the audit log…</p>
          ) : filtered.length === 0 ? (
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

/* ------------------------------------------------------- managing the team */

/**
 * Whether removing this person would leave the branch with no owner.
 *
 * Counted over the real membership rows rather than the cached role, so the
 * guard matches what the database would decide. `currentUserId` is the signed-in
 * owner: someone cannot remove themselves out of the last owner seat either.
 */
function isLastOwner(
  members: { userId: string; role: string }[],
  userId: string,
  currentUserId: string,
): boolean {
  if (userId !== currentUserId) return false;
  return members.filter((member) => member.role === 'owner').length <= 1;
}

/** Owner-only: issue an invitation and show the code to share. */
function InviteDialog({
  onInvite,
}: {
  onInvite: (
    email: string,
    role: StaffRole,
    fullName?: string,
  ) => Promise<{ created: boolean; emailed: boolean }>;
}) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('assistant');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setProblem(null);

    const { created, emailed } = await onInvite(email.trim(), role, fullName.trim() || undefined);

    setBusy(false);

    // The three outcomes, kept distinct. `notice` above the list carries the
    // full message; the dialog only decides whether to keep the owner here.
    //
    // Closed when the invitation EXISTS, emailed or not — there is nothing to
    // retry in this dialog, because retrying would create a second invitation
    // and withdraw the first. A failed send is fixed by sharing the link, or by
    // re-sending from the invitations list.
    if (created) {
      setEmail('');
      setFullName('');
      setRole('assistant');
      setOpen(false);
      return;
    }

    setProblem('The invitation was not created. See the message above for the reason.');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" size="sm">
            <UserPlus className="size-4" />
            Add staff
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add someone to your team</DialogTitle>
          <DialogDescription>
            They set their own password. You never see it, and this app never stores it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-name">Their name</Label>
            <Input
              id="invite-name"
              autoComplete="off"
              placeholder="e.g. Aisha Yusuf"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Used to address the invitation email. Optional.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-email">Their email address</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The invitation only works for this exact address, and we send it there.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(value) => setRole((value ?? 'assistant') as StaffRole)}>
              <SelectTrigger id="invite-role" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assistant">Assistant</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only an owner can approve incoming stock pricing. An assistant can request it.
            </p>
          </div>

          {problem && <p className="text-sm text-warning">{problem}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="button" onClick={() => void submit()} disabled={busy || !email.trim()}>
            {busy ? 'Creating and sending…' : 'Create and send invitation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Copies an invitation code, or the full join link.
 *
 * Two buttons rather than one because they answer different needs: the code is
 * what you read down the phone to someone standing at the counter, and the link
 * is what goes into a message. The link is built from `invitationLink`, which
 * takes the base address from configuration rather than from whatever browser the
 * owner happens to be using — otherwise it would point at `localhost`, which means
 * the reader's own device and not the pharmacy's.
 */
function CopyToken({ token }: { token: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const copy = (what: 'code' | 'link', value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => copy('code', token)}>
        {copied === 'code' ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied === 'code' ? 'Copied' : 'Copy code'}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => copy('link', invitationLink(token))}
      >
        {copied === 'link' ? <Check className="size-4" /> : <LinkIcon className="size-4" />}
        {copied === 'link' ? 'Copied' : 'Copy link'}
      </Button>
    </>
  );
}

/**
 * Owner-only: end someone's access.
 *
 * The confirmation says what actually happens — the account survives, their place
 * at this branch does not — because "remove" invites the assumption that a person
 * and their access are the same thing.
 */
function RemoveMemberButton({
  userId,
  name,
  onRemove,
}: {
  userId: string;
  name: string;
  onRemove: (userId: string, name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="ghost" size="sm">
            <Trash2 className="size-4" />
            Remove
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
          <DialogDescription>
            They lose access to this pharmacy immediately, and it is recorded in the audit
            log. Their account itself is kept, so they can be invited back later without
            losing anything they did.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Keep them</DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const removed = await onRemove(userId, name);
              setBusy(false);
              if (removed) setOpen(false);
            }}
          >
            {busy ? 'Removing…' : 'Remove access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
