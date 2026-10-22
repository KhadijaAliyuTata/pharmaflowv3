import { createFileRoute } from '@tanstack/react-router';
import { BookOpen, FlaskConical, Info } from 'lucide-react';
import { Card, CardContent } from '~/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { PageHeader } from '~/components/app/primitives';
import { MedicineCataloguePanel } from '~/components/medicine/medicine-catalogue-panel';
import { PharmacyDossier } from '~/components/medicine/pharmacy-dossier';
import { isDemoMode } from '~/lib/session';

export const Route = createFileRoute('/_app/medicine-info')({
  component: MedicineInfo,
});

/**
 * Two different things share the name "medicine information":
 *
 *   * the shared clinical catalogue, which is global and reviewer-verified;
 *   * this pharmacy's stock dossier, which is tenant-scoped and contains local
 *     batches, prices and quantities.
 *
 * They are separate tabs rather than one merged table, because merging them
 * would make a local stock row look like a verified clinical source. The shared
 * catalogue is live-only: demo seeds are fictional and must never be presented
 * as clinical evidence.
 */
function MedicineInfo() {
  const demo = isDemoMode();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Medicine info"
        description="Shared professional reference and this pharmacy’s local stock dossier. Not a prescription or patient-specific advice."
      />

      <Tabs defaultValue={demo ? 'pharmacy' : 'catalogue'}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="catalogue">
            <BookOpen />
            Reference catalogue
          </TabsTrigger>
          <TabsTrigger value="pharmacy">
            <FlaskConical />
            My pharmacy
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalogue">
          {demo ? <CatalogueUnavailableInDemo /> : <MedicineCataloguePanel />}
        </TabsContent>

        <TabsContent value="pharmacy">
          <PharmacyDossier />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CatalogueUnavailableInDemo() {
  return (
    <Card>
      <CardContent className="space-y-3 py-8">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-muted p-2">
            <BookOpen className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">The shared catalogue is not available in demo mode</h2>
            <p className="text-sm text-muted-foreground">
              Demo medicines are fictional. Their names, quantities and NAFDAC-style identifiers
              are not a clinical source and must never be used to treat a patient or imported into
              the real catalogue.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            Use the <strong>My pharmacy</strong> tab to explore the demo inventory. The real
            shared reference catalogue, its sources and verification status appear only in a live
            deployment with Supabase configured.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
