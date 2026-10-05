import { useEffect, useRef, useState } from 'react';

/**
 * A search box whose value is seeded from the URL's `?q=`.
 *
 * ## Why this exists
 *
 * The header's global search navigates to existing list screens with the term it
 * matched, e.g. `/inventory?q=Paracetamol`. Without this, the user would land on
 * the full list with the term silently dropped and have to retype it.
 *
 * ## Why the state is still local
 *
 * The query is a local `useState`, not a value read straight from the URL. These
 * screens are the ones that *own* their search; making every keystroke write a
 * history entry would put a URL update in the path of each character. So the URL
 * seeds the box once, and the box owns it from then on.
 *
 * The re-seed effect covers the remaining case: the user is already on the list
 * and searches again from the header, so the param changes while the component is
 * mounted. Without it, the second search would look like it did nothing.
 */
export function useSeedQuery(seed: string | undefined): [string, (value: string) => void] {
  const [query, setQuery] = useState(seed ?? '');
  const applied = useRef(seed ?? '');

  useEffect(() => {
    if (seed === undefined || seed === applied.current) return;
    applied.current = seed;
    setQuery(seed);
  }, [seed]);

  return [query, setQuery];
}
