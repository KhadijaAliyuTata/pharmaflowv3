import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Inbox, Radio, TrendingUp } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { PageHeader, SectionTitle, StatTile } from '~/components/app/primitives';
import { demandRadar, demandRadarSummary } from '~/domain/dashboard';
import { usePharmacy } from '~/store/pharmacy';

/**
 * Demand Radar — what customers asked for that this pharmacy could not supply.
 *
 * ## The data is real or it is absent
 *
 * This screen is powered entirely by `state.medicineRequests`, the recorded
 * `medicine_requests` rows: a medicine name, a quantity, an urgency, a customer
 * and a timestamp, captured when a request comes in. Nothing here is seeded for
 * the sake of a fuller-looking dashboard. If no requests have been recorded, the
 * screen says so with an empty state — an invented "7 unmet requests this week"
 * would be the single most damaging thing on an owner's dashboard, because it
 * would drive purchasing decisions from numbers that never existed.
 *
 * ## What it deliberately does not claim
 *
 * The schema records *what was requested and when*, not *whether stock happened
 * to be available at that moment*. So this screen does not assert "we were out
 * of stock". `request.state` (`pending_restock` / `restocked` / `notified`) is
 * what was actually recorded, and that is what is shown.
 *
 * Whether the pharmacy had stock at request time would need a historical
 * availability lookup that does not exist yet; inferring it from today's stock
 * would be a plausible-sounding fiction. It is left out on purpose.
 */
export const Route = createFileRoute('/_app/demand-radar')({
  component: DemandRadarScreen,
});

const URGENCY_VARIANT = {
  emergency: 'destructive',
  urgent: 'warning',
  routine: 'secondary',
} as const;

const URGENCY_LABEL = {
  emergency: 'Emergency',
  urgent: 'Urgent',
  routine: 'Routine',
} as const;

const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

function DemandRadarScreen() {
  const medicineRequests = usePharmacy((state) => state.medicineRequests);
  const medicines = usePharmacy((state) => state.medicines);
  const [days, setDays] = useState<number>(30);

  const rows = useMemo(
    () => demandRadar({ medicineRequests }, days),
    [medicineRequests, days],
  );
  const summary = useMemo(() => demandRadarSummary(rows), [rows]);

  /**
   * Current catalogue name match, so the owner can see at a glance whether an
   * unmet request is a product they carry. This is explicitly labelled "now" —
   * it is today's stock, not stock on the day of the request.
   */
  const inCatalogue = useMemo(() => {
    const names = new Set(medicines.map((medicine) => medicine.name.toLowerCase()));
    return (requested: string) => names.has(requested.trim().toLowerCase());
  }, [medicines]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Demand Radar"
        description="What customers asked for, and whether it is still waiting."
        meta={
          <p className="text-xs text-muted-foreground">
            Built from recorded requests. Availability is shown for the current catalogue only,
            not for the moment of the request.
          </p>
        }
        actions={
          <Button variant="outline" render={<Link to="/stock-intelligence" />}>
            <TrendingUp className="size-4" />
            Reorder suggestions
          </Button>
        }
      />

      <div role="group" aria-label="Time window" className="flex flex-wrap items-center gap-1.5">
        <Radio className="size-4 shrink-0 text-muted-foreground" />
        <span className="mr-1 text-sm font-medium">Window</span>
        {WINDOWS.map((window) => {
          const selected = window.days === days;
          return (
            <Button
              key={window.days}
              size="sm"
              variant={selected ? 'default' : 'outline'}
              aria-pressed={selected}
              onClick={() => setDays(window.days)}
            >
              {window.label}
            </Button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Unmet requests"
          value={summary.openCount}
          hint={`${summary.requestCount} recorded in total`}
          icon={<Inbox className="size-4" />}
          tone={summary.openCount > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Distinct products"
          value={summary.productCount}
          hint="Asked for at least once"
        />
        <StatTile label="Units requested" value={summary.unitsRequested} hint="Across all requests" />
        <StatTile
          label="Emergencies"
          value={summary.emergencies}
          hint="Marked emergency when recorded"
          tone={summary.emergencies > 0 ? 'critical' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle>Requested products</SectionTitle>
        </CardHeader>
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>No unmet demand recorded</EmptyTitle>
                <EmptyDescription>
                  No customer requests were recorded in the last {days} days, so there is nothing
                  to restock from. Requests captured at the counter or through the portal appear
                  here automatically.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requested</TableHead>
                    <TableHead className="text-right">Times asked</TableHead>
                    <TableHead className="text-right">Units wanted</TableHead>
                    <TableHead>Highest urgency</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last asked</TableHead>
                    <TableHead>In catalogue now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.medicineName}>
                      <TableCell>
                        <p className="font-medium">{row.medicineName}</p>
                        {row.genericName && (
                          <p className="text-xs text-muted-foreground">{row.genericName}</p>
                        )}
                        {row.customerNames.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Asked by {row.customerNames.slice(0, 2).join(', ')}
                            {row.customerNames.length > 2
                              ? ` +${row.customerNames.length - 2} more`
                              : ''}
                          </p>
                        )}
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right">
                        {row.requestCount}
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right">
                        {row.unitsRequested}
                      </TableCell>
                      <TableCell>
                        {/* Urgency is text + colour, never colour alone. */}
                        <Badge variant={URGENCY_VARIANT[row.urgency]}>
                          {URGENCY_LABEL[row.urgency]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.open ? 'warning' : 'secondary'}>
                          {row.open ? 'Awaiting restock' : 'Resolved'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.lastRequestedLabel}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {inCatalogue(row.medicineName) ? 'Carried' : 'Not carried'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
