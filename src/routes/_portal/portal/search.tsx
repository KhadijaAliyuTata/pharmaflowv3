import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Ban, Lock, MapPin, Pill, SearchX } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty';
import { PortalSearchBox } from '~/components/portal-search';
import { Money, StatusBadge } from '~/components/app/primitives';
import { searchMedicines } from '~/domain/selectors';
import { availabilityFor, usePortalCustomer } from '~/lib/portal';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_portal/portal/search')({
  component: PortalSearch,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : '',
  }),
});

const RX_VARIANT = {
  Prescription: 'warning',
  Controlled: 'destructive',
  OTC: 'secondary',
} as const;

function PortalSearch() {
  // `q` is read from the URL, not local state, so a search is shareable and
  // the back button steps through searches. The field is uncontrolled-ish via
  // the shared box's initial value.
  const { q } = Route.useSearch();
  const [branch] = usePharmacy((state) => [state.branch] as const);
  const results = usePharmacy((state) => searchMedicines(state.medicines, q));

  // The catalog has one branch. Listing it once is honest; inventing four
  // pharmacies to fill a directory grid would be fiction.
  const availableCount = results.filter(
    (medicine) => availabilityFor(medicine, branch)[0]?.status === 'in_stock',
  ).length;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Search medicines</h1>
        <p className="text-sm text-muted-foreground">
          What {branch.name} has on the shelf right now.
        </p>
      </div>

      <PortalSearchBox initialQuery={q} />

      {q.trim() === '' ? (
        <Card>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {results.length} products in the catalog. Search by brand, generic name or
              strength.
            </p>
            <p className="text-xs text-muted-foreground">
              One branch is on this portal. Multi-branch availability is not wired up.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {results.length} result{results.length === 1 ? '' : 's'} for “{q.trim()}” ·{' '}
            {availableCount} in stock
          </p>

          {results.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>Nothing matches that</EmptyTitle>
                <EmptyDescription>
                  Try the generic name instead of the brand, or check the spelling.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="space-y-3">
              {results.map((medicine) => {
                const availability = availabilityFor(medicine, branch);
                const prescriptionOnly = medicine.prescriptionStatus !== 'OTC';

                return (
                  <li key={medicine.id}>
                    <Card>
                      <CardContent className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate text-sm font-semibold">
                              {medicine.name}
                            </h2>
                            <p className="truncate text-xs text-muted-foreground">
                              {medicine.genericName} · {medicine.strength} ·{' '}
                              {medicine.dosageForm}
                            </p>
                          </div>
                          <StatusBadge status={availability[0]?.status ?? 'out_of_stock'} />
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={RX_VARIANT[medicine.prescriptionStatus]}>
                            {prescriptionOnly ? 'Prescription only' : 'Over the counter'}
                          </Badge>
                          {medicine.isBrand && medicine.genericEquivalentId && (
                            <Badge variant="outline">Generic available</Badge>
                          )}
                        </div>

                        <dl className="grid gap-2 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="text-muted-foreground">Price from</dt>
                            <dd className="text-sm font-medium">
                              <Money value={medicine.units[0]?.sellingPrice ?? 0} /> per{' '}
                              {medicine.units[0]?.name.toLowerCase() ?? 'unit'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Collect at</dt>
                            <dd className="flex items-center gap-1 text-sm font-medium">
                              <MapPin className="size-3.5 text-muted-foreground" />
                              {branch.name}
                            </dd>
                          </div>
                        </dl>

                        <p className="text-xs text-muted-foreground">{medicine.commonUse}</p>

                        {/* No cart, no "order" button. There is no operation to
                            submit an order with, so a button here would only
                            ever lie to a patient. */}
                        <div className="flex items-center gap-2 border-t pt-3">
                          <Button variant="outline" size="sm" disabled>
                            <Lock className="size-3.5" />
                            Ordering not available
                          </Button>
                          <span className="text-xs text-muted-foreground">
                            Needs a cart and order operation.
                          </span>
                        </div>

                        {availability[0]?.status === 'expired' && (
                          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Ban className="mt-0.5 size-3 shrink-0" />
                            Every batch has passed its date. We will not dispense it.
                          </p>
                        )}

                        {availability[0]?.status === 'out_of_stock' && (
                          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Pill className="mt-0.5 size-3 shrink-0" />
                            We cannot order it for you online. Ask the counter to request a
                            restock.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3 shrink-0" />
        Prices come from live stock records. Ordering, payment and prescription upload are
        not built.
      </p>
    </div>
  );
}
