/**
 * Pharmacy management, and the onboarding form.
 *
 * Search and filtering happen over the page already fetched, which is the right
 * trade at pilot scale; the query itself is paginated so the list does not grow
 * without bound. If the platform ever needs server-side search, the filter moves
 * into `listPharmacies` and nothing on this screen has to change - the rows
 * already arrive shaped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  listPharmacies,
  onboardPharmacy,
  setPharmacyStatus,
  type PlatformPharmacy,
} from '~/lib/supabase/platform';

export const Route = createFileRoute('/platform/pharmacies')({
  component: PlatformPharmacies,
});

const PAGE_SIZE = 25;

type StatusFilter = 'all' | 'pending' | 'active' | 'suspended';

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'secondary'> = {
  active: 'success',
  pending: 'warning',
  suspended: 'secondary',
};

function PlatformPharmacies() {
  const [rows, setRows] = useState<PlatformPharmacy[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    pharmacy: PlatformPharmacy;
    next: 'suspended' | 'active';
  } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listPharmacies(PAGE_SIZE, page * PAGE_SIZE);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRows(result.data.rows);
    setTotal(result.data.count);
    setError(null);
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (status !== 'all' && p.status !== status) return false;
      if (!needle) return true;
      return (
        p.name.toLowerCase().includes(needle) ||
        (p.city ?? '').toLowerCase().includes(needle) ||
        (p.owner_name ?? '').toLowerCase().includes(needle) ||
        (p.owner_invitation_email ?? '').toLowerCase().includes(needle)
      );
    });
  }, [rows, search, status]);

  const applyStatus = async () => {
    if (!confirm) return;
    if (confirm.next === 'suspended' && !reason.trim()) return;

    const result = await setPharmacyStatus(
      confirm.pharmacy.id,
      confirm.next,
      confirm.next === 'suspended' ? reason.trim() : undefined,
    );

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      result.data.changed
        ? `${confirm.pharmacy.name} is now ${confirm.next}`
        : `${confirm.pharmacy.name} was already ${confirm.next}`,
    );
    setConfirm(null);
    setReason('');
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pharmacies</h1>
          <p className="text-sm text-muted-foreground">
            {total} registered ? showing {rows.length} on this page
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add Pharmacy
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-56 flex-1">
          <FieldLabel htmlFor="pharmacy-search">Search this page</FieldLabel>
          <Input
            id="pharmacy-search"
            value={search}
            placeholder="Name, city, owner or email"
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <Field className="w-44">
          <FieldLabel htmlFor="pharmacy-status">Status</FieldLabel>
          <select
            id="pharmacy-status"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">All</option>
            <option value="pending">Awaiting onboarding</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </Field>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardContent className="px-0">
          {visible.length === 0 && !loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {rows.length === 0
                ? 'No pharmacies are registered yet.'
                : 'No pharmacy on this page matches that search.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pharmacy</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Staff</TableHead>
                  <TableHead>Invitation</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[p.city, p.state].filter(Boolean).join(', ') || '?'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[p.status] ?? 'secondary'}>{p.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{p.owner_name ?? '?'}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.owner_invitation_email ?? ''}
                      </p>
                    </TableCell>
                    <TableCell data-numeric className="tabular">
                      {p.member_count}
                    </TableCell>
                    <TableCell>
                      {p.owner_accepted_at ? (
                        <span className="text-xs text-muted-foreground">accepted</span>
                      ) : (
                        <Badge variant="warning">outstanding</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.status === 'suspended' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirm({ pharmacy: p, next: 'active' })}
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirm({ pharmacy: p, next: 'suspended' })}
                        >
                          Suspend
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <AddPharmacyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={async () => {
          await load();
        }}
      />

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setReason('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-warning" />
              {confirm?.next === 'suspended' ? 'Suspend' : 'Reactivate'}{' '}
              {confirm?.pharmacy.name}?
            </DialogTitle>
            <DialogDescription>
              {confirm?.next === 'suspended'
                ? 'Their owners and staff lose access immediately. Nothing is deleted: every sale, customer and order is retained and returns intact if you reactivate.'
                : 'Their owners and staff regain access to everything they had before.'}
            </DialogDescription>
          </DialogHeader>

          {confirm?.next === 'suspended' && (
            <Field>
              <FieldLabel htmlFor="suspend-reason">Reason</FieldLabel>
              <Input
                id="suspend-reason"
                value={reason}
                placeholder="Recorded on the pharmacy and in the audit log"
                onChange={(e) => setReason(e.target.value)}
              />
              {!reason.trim() && <FieldError>A reason is required.</FieldError>}
            </Field>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.next === 'suspended' ? 'destructive' : 'default'}
              disabled={confirm?.next === 'suspended' && !reason.trim()}
              onClick={() => void applyStatus()}
            >
              {confirm?.next === 'suspended' ? 'Suspend pharmacy' : 'Reactivate pharmacy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------ onboarding form */

function AddPharmacyDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    pharmacyName: '',
    ownerName: '',
    ownerEmail: '',
    phone: '',
    address: '',
    city: '',
    state: '',
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    const result = await onboardPharmacy(form);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    // Two distinct outcomes, and conflating them would tell the operator an
    // email went out when it did not.
    if (result.data.emailSent) {
      toast.success(`${result.data.pharmacyName} onboarded — invitation emailed.`);
    } else {
      toast.warning(
        `${result.data.pharmacyName} created, but the invitation email was not sent.`,
        { description: result.data.emailError ?? undefined },
      );
    }

    setForm({
      pharmacyName: '',
      ownerName: '',
      ownerEmail: '',
      phone: '',
      address: '',
      city: '',
      state: '',
    });
    onOpenChange(false);
    await onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a pharmacy</DialogTitle>
          <DialogDescription>
            Creates the pharmacy and emails its owner a single-use invitation link.
            The owner sets their own password — no password is ever created or
            sent for them.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="p-name">Pharmacy name</FieldLabel>
            <Input
              id="p-name"
              value={form.pharmacyName}
              onChange={(e) => set('pharmacyName')(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-owner">Owner's name</FieldLabel>
            <Input id="p-owner" value={form.ownerName} onChange={(e) => set('ownerName')(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-email">Owner's email</FieldLabel>
            <Input
              id="p-email"
              type="email"
              value={form.ownerEmail}
              onChange={(e) => set('ownerEmail')(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-phone">Phone</FieldLabel>
            <Input id="p-phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-city">City</FieldLabel>
            <Input id="p-city" value={form.city} onChange={(e) => set('city')(e.target.value)} />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="p-address">Address</FieldLabel>
            <Input
              id="p-address"
              value={form.address}
              onChange={(e) => set('address')(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-state">State</FieldLabel>
            <Input id="p-state" value={form.state} onChange={(e) => set('state')(e.target.value)} />
          </Field>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              submitting ||
              !form.pharmacyName.trim() ||
              !form.ownerName.trim() ||
              !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.ownerEmail.trim())
            }
          >
            {submitting ? 'Creating…' : 'Create and invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}