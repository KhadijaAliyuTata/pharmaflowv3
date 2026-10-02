import { Link } from '@tanstack/react-router';
import { Home, SearchX } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '~/components/ui/empty';

/**
 * Renders when a URL matches no route, or when a loader throws NotFound.
 * Registered as `notFoundComponent` on the root route — `errorComponent` does
 * not cover this case, which is why the default "Not Found" text appeared
 * before this existed.
 */
export function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Empty className="w-full max-w-md">
        <EmptyHeader>
          <div
            aria-hidden="true"
            className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full"
          >
            <SearchX className="size-5" />
          </div>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            That link does not lead anywhere. It may have been moved, or the
            screen may not have been ported yet.
          </EmptyDescription>
        </EmptyHeader>

        <Button variant="outline" render={<Link to="/" />}>
          <Home />
          Back to dashboard
        </Button>
      </Empty>
    </div>
  );
}
