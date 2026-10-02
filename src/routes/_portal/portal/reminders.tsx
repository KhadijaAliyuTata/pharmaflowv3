import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Lock, MessageCircle, Smartphone } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Field, FieldLabel } from '~/components/ui/field';
import { Textarea } from '~/components/ui/textarea';
import { StatTile, StatusBadge } from '~/components/app/primitives';
import { formatDate, formatRelative } from '~/domain/money';
import type { Medicine } from '~/domain/types';
import { refillRows, usePortalCustomer } from '~/lib/portal';
import { useLocalReminders } from '~/hooks/use-local-reminders';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_portal/portal/reminders')({
  component: PortalReminders,
});

const COVERED: ReadonlySet<string> = new Set(['in_stock', 'low_stock', 'expiring_soon']);

function PortalReminders() {
  const customer = usePortalCustomer();
  const branch = usePharmacy((state) => state.branch);
  const rows = usePharmacy((state) =>
    customer === null ? [] : refillRows(customer, state.medicines, state.sales),
  );

  const { reminders, loaded, save } = useLocalReminders();

  const covered = rows.filter((row) => COVERED.has(row.status));
  const uncovered = rows.filter((row) => !COVERED.has(row.status));
  const latestEdit = reminders.reduce<string | null>(
    (latest, entry) => (latest === null || entry.savedAt > latest ? entry.savedAt : latest),
    null,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Medication reminders</h1>
        <p className="text-sm text-muted-foreground">
          Your regular medicines and how long {branch.name} expects to hold them.
        </p>
      </div>

      {customer === null ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No customer record. Reminders need a registered patient.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="On your list" value={rows.length} hint="Chronic medications" />
            <StatTile label="Available now" value={covered.length} hint="Usable stock" />
            <StatTile label="Not available" value={uncovered.length} hint="Ask at the counter" />
          </div>

          {rows.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No chronic medications are recorded against your account.
                </p>
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={row.medicine.id}>
                  <Card>
                    <CardContent className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-semibold">
                            {row.medicine.name}
                          </h2>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.medicine.genericName} · {row.medicine.strength} ·{' '}
                            {row.medicine.dosageForm}
                          </p>
                        </div>
                        <StatusBadge status={row.status} />
                      </div>

                      <dl className="grid gap-3 text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-muted-foreground">Last dispensed</dt>
                          <dd className="font-medium">
                            {row.lastDispensedAt === null ? (
                              'No record here'
                            ) : (
                              <>
                                {formatDate(row.lastDispensedAt)}
                                <span className="block text-muted-foreground">
                                  {row.daysSinceDispensed ?? 0} days ago
                                </span>
                              </>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Next refill</dt>
                          <dd className="font-medium">
                            {formatDate(row.estimatedRefillDate)}
                            <span className="block text-muted-foreground">
                              in {row.daysUntilRefill} days
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">At the branch</dt>
                          <dd className="font-medium">
                            {COVERED.has(row.status) ? 'Available' : 'Not available'}
                          </dd>
                        </div>
                      </dl>

                      <p className="border-t pt-3 text-xs text-muted-foreground">
                        Refill dates are {branch.name}'s remaining stock moving at the rate it
                        currently sells. That is a shelf estimate, not a dosing schedule — ask
                        your pharmacist when to take or restart anything.
                      </p>

                      {loaded && (
                        <NoteField
                          medicine={row.medicine}
                          initial={reminders.find(
                            (entry) => entry.medicineId === row.medicine.id,
                          )?.note ?? ''}
                          onSave={save}
                        />
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}

          <Card>
            <CardHeader className="border-b pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Message reminders</h2>
                <Badge variant="outline">Not wired up</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Nothing is sent by SMS or WhatsApp. This is a list, not a service.
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  <Smartphone className="size-3 shrink-0" />
                  SMS needs SMS_API_KEY and SMS_SENDER_ID.
                </li>
                <li className="flex items-center gap-1.5">
                  <MessageCircle className="size-3 shrink-0" />
                  WhatsApp needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.
                </li>
                <li className="flex items-center gap-1.5">
                  <Lock className="size-3 shrink-0" />
                  A scheduled sender would also need a Worker cron trigger and a refill job.
                  Neither exists.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">
                  Reminder consent
                </h2>
                <Badge variant={customer.consentForReminders ? 'success' : 'secondary'}>
                  {customer.consentForReminders ? 'On' : 'Off'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Recorded on your pharmacy file. Changing it here would not reach the
                pharmacy, so it is not offered — ask at the counter.
              </p>
              <Button variant="outline" size="sm" disabled>
                <Lock className="size-3.5" />
                Change consent
              </Button>
            </CardContent>
          </Card>

          <p className="border-t pt-4 text-xs text-muted-foreground">
            Notes are saved in this browser under{' '}
            <code className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono">
              pharmaflow:portal:reminders:v1
            </code>
            . Device-local: not synced, not sent, not visible to the pharmacy.
            {latestEdit !== null && ` Last edited ${formatRelative(latestEdit)}.`}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A note that saves on blur, not on every keystroke. Writing to localStorage
 * per character is the same mistake the staff store made with POS cart typing,
 * and the same fix applies.
 */
function NoteField({
  medicine,
  initial,
  onSave,
}: {
  medicine: Medicine;
  initial: string;
  onSave: (medicineId: string, note: string) => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <Field>
      <FieldLabel htmlFor={`note-${medicine.id}`}>
        My note for {medicine.name} (this device only)
      </FieldLabel>
      <Textarea
        id={`note-${medicine.id}`}
        rows={2}
        placeholder="e.g. take after food"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onSave(medicine.id, value)}
      />
    </Field>
  );
}
