import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '~/components/ui/empty';

/**
 * The router-level error boundary. Also used as the `notFound` component, so
 * this file is the single home for "something went wrong, here is the way out".
 */
export function DefaultCatchBoundary({ error, reset }: ErrorComponentProps) {
  // ErrorComponentProps types `error` as `{}`; narrow before reading it.
  const err = error instanceof Error ? error : undefined;
  const isNotFound = err?.name === 'NotFound';
  const message = isNotFound
    ? 'We could not find that page.'
    : 'Something went wrong on our side.';

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <Empty className="w-full max-w-md">
        <EmptyHeader>
          <div
            aria-hidden="true"
            className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full"
          >
            {isNotFound ? (
              <Home className="size-5" />
            ) : (
              <AlertTriangle className="size-5" />
            )}
          </div>
          <EmptyTitle>{isNotFound ? 'Page not found' : 'Unexpected error'}</EmptyTitle>
          <EmptyDescription>{message}</EmptyDescription>
        </EmptyHeader>

        {!isNotFound && err && (
          <pre className="bg-muted text-muted-foreground max-h-40 w-full overflow-auto rounded-md p-3 text-left font-mono text-xs">
            {err.message}
          </pre>
        )}

        <div className="flex gap-2">
          {!isNotFound && (
            <Button variant="outline" onClick={reset}>
              <RefreshCw />
              Try again
            </Button>
          )}
          <Button variant="outline" render={<Link to="/" />}>
            <ArrowLeft />
            Back to dashboard
          </Button>
        </div>
      </Empty>
    </div>
  );
}
