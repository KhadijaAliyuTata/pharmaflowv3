import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';

export function ScreenPlaceholder({
  title,
  description,
  icon: Icon,
  from,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Where this screen came from in v2, so the port has a reference. */
  from: string;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Icon className="size-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <Badge variant="secondary">Not ported</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Port source</CardTitle>
          <CardDescription>
            This route exists so navigation and routing are real, not stubbed with
            hashes. The screen itself is not ported yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
            {from}
          </code>
        </CardContent>
      </Card>
    </div>
  );
}
