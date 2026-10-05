import { useState, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  Clock,
  CreditCard,
  Database,
  MapPin,
  MessageCircle,
  Phone,
  Printer,
  RotateCcw,
  Smartphone,
  Star,
  Store,
} from 'lucide-react';
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
import { PageHeader, SectionTitle } from '~/components/app/primitives';
import { usePharmacy, useResetPharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsScreen,
});

interface Integration {
  title: string;
  icon: typeof Printer;
  purpose: string;
  requires: string[];
}

const INTEGRATIONS: Integration[] = [
  {
    title: 'Printer / ESC-POS',
    icon: Printer,
    purpose: 'Prints receipts and GRN slips on the 58mm thermal printer.',
    requires: ['Worker binding ESC_POS_SERVICE', 'secret ESC_POS_TOKEN'],
  },
  {
    title: 'WhatsApp Business',
    icon: MessageCircle,
    purpose: 'Sends order updates and prescription-ready messages.',
    requires: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
  },
  {
    title: 'SMS gateway',
    icon: Smartphone,
    purpose: 'Text alerts for expiring batches and refill reminders.',
    requires: ['SMS_API_KEY', 'SMS_SENDER_ID'],
  },
  {
    title: 'Paystack',
    icon: CreditCard,
    purpose: 'Card and transfer checkout, with webhook settlement.',
    requires: ['PAYSTACK_SECRET_KEY', 'PAYSTACK_WEBHOOK_SECRET'],
  },
  {
    title: 'Data & sync',
    icon: Database,
    purpose: 'Moves this browser-local state into D1 so branches share records.',
    requires: ['D1 binding DB', 'SYNC_TOKEN'],
  },
];

function SettingsScreen() {
  const branch = usePharmacy((state) => state.branch);
  const reset = useResetPharmacy();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="What this branch is, and what is still missing."
        meta={
          <p className="text-xs text-muted-foreground">
            Nothing here saves. State lives in this browser under{' '}
            <code className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono">
              pharmaflow:state:v3
            </code>{' '}
            — there is no backend yet.
          </p>
        }
      />

      <Card>
        <CardHeader className="border-b pb-3">
            <SectionTitle
              action={
                <Badge variant="secondary">{INTEGRATIONS.length} not configured</Badge>
              }
            >
              Integrations
            </SectionTitle>
        </CardHeader>
        <CardContent>
          <p className="pb-3 text-sm text-muted-foreground">
            None of these are implemented. There is nothing to turn on.
          </p>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {INTEGRATIONS.map((integration) => {
              const Icon = integration.icon;

              return (
                <Card key={integration.title} size="sm">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Icon className="size-4 text-muted-foreground" />
                        {integration.title}
                      </CardTitle>
                      <Badge variant="outline">Not wired up</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-muted-foreground">{integration.purpose}</p>
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Requires</p>
                      <ul className="flex flex-wrap gap-1">
                        {integration.requires.map((requirement) => (
                          <li key={requirement}>
                            <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                              {requirement}
                            </code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <p className="pt-3 text-xs text-muted-foreground">
            Secrets belong in{' '}
            <code className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono">
              .dev.vars
            </code>{' '}
            locally and in Wrangler secrets in production, never in the repository.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle>Branch profile</SectionTitle>
            <Badge variant="outline">Read only</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail icon={<Store />} label="Branch">
              {branch.name}
              {branch.isMainHub && (
                <Badge variant="secondary" className="ml-2">
                  Main hub
                </Badge>
              )}
            </Detail>

            <Detail icon={<MapPin />} label="Address">
              {branch.address}
              <span className="block text-muted-foreground">
                {branch.city}, {branch.state}
              </span>
            </Detail>

            <Detail icon={<Phone />} label="Phone">
              <span className="tabular">{branch.phone}</span>
            </Detail>

            <Detail icon={<Clock />} label="Opening hours">
              {branch.openingHours}
              <Badge variant={branch.isOpenNow ? 'success' : 'secondary'} className="ml-2">
                {branch.isOpenNow ? 'Open now' : 'Closed'}
              </Badge>
            </Detail>

            <Detail icon={<Star />} label="Rating">
              <span className="tabular">{branch.rating}</span> from {branch.reviewsCount}{' '}
              reviews
            </Detail>
          </dl>

          <p className="pt-4 text-xs text-muted-foreground">
            Editing the branch profile is not wired up — there is no operation for it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle>Demo data</SectionTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            <RotateCcw className="size-4" />
            Reset demo data
          </Button>
          <p className="text-xs text-muted-foreground">
            Throws away every sale, receipt and adjustment made in this browser and reloads
            the seed.
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset demo data?</DialogTitle>
            <DialogDescription>
              This clears the state saved in this browser and reloads the seed data. Sales,
              receipts, stock movements and audit entries recorded in this session are lost,
              and cannot be recovered.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                reset();
                setConfirmOpen(false);
              }}
            >
              Reset demo data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="[&>svg]:size-3.5">{icon}</span>
        {label}
      </dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}
