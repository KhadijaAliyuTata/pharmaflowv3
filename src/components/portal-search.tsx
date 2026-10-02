import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

/**
 * The portal's medicine search field.
 *
 * Client-side navigation rather than a plain `<form action>` GET, so the query
 * lives in the URL (shareable, survives a reload, and the browser back button
 * walks the search history) without a full document round trip through the
 * Worker.
 */
export function PortalSearchBox({
  initialQuery = '',
  autoFocus = false,
}: {
  initialQuery?: string;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);

  return (
    <form
      role="search"
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void navigate({
          to: '/portal/search',
          search: { q: query.trim() },
        });
      }}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Name, generic or brand"
        aria-label="Search medicines"
        autoFocus={autoFocus}
      />
      <Button type="submit" variant="secondary">
        Search
      </Button>
    </form>
  );
}
