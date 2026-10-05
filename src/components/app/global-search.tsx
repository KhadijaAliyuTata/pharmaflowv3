import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Building2, Package, Search, Truck, User, Users, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Kbd } from '~/components/ui/kbd';
import { CATEGORY_LABEL, globalSearch, type SearchCategory, type SearchResult } from '~/domain/search';
import { usePharmacy } from '~/store/pharmacy';

/**
 * Global search across this pharmacy's records.
 *
 * ## Why this is not the ⌘K command palette
 *
 * The app has two genuinely different jobs, and they used to share one control:
 *
 *  1. **Search records** — find a specific medicine, supplier, staff member or
 *     customer. This component.
 *  2. **Jump to a screen** — the ⌘K palette, which lists navigation targets.
 *
 * They are separate concerns and are now separate components. The ⌘K palette no
 * longer carries a theme item, and this search does not import the theme at all,
 * so typing here cannot change the theme. See `command-menu.tsx`.
 *
 * ## Scope
 *
 * Results come from the store, which only holds the active branch's RLS-scoped
 * data, so a search can never surface another pharmacy's records. No cost or
 * margin figure is rendered here, so the results are safe for an assistant to
 * see. `~/domain/search` documents both.
 *
 * ## Keyboard
 *
 * Built on the Base UI `Dialog`, so focus trapping, Escape-to-close and the
 * `aria-modal` semantics come from the primitive. The up/down/enter handling is
 * local, because the result list is a flat, explicitly-ordered set of links
 * rather than a cmdk command tree.
 */

const ICON_FOR: Record<SearchCategory, typeof Package> = {
  medicines: Package,
  suppliers: Truck,
  staff: User,
  customers: Users,
};

/** Below this many characters there is nothing useful to show. */
const MIN_QUERY = 2;

export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only the four collections search actually reads, each as its own selector
  // call. Selecting the whole state would re-render this on every stock tick in
  // the app, which is the exact problem the store's per-slice design avoids.
  const medicines = usePharmacy((s) => s.medicines);
  const suppliers = usePharmacy((s) => s.suppliers);
  const users = usePharmacy((s) => s.users);
  const customers = usePharmacy((s) => s.customers);

  const results = useMemo(
    () => globalSearch({ medicines, suppliers, users, customers }, query),
    [medicines, suppliers, users, customers, query],
  );

  // Reset per open, so reopening never shows the previous query's results and
  // the caret starts in a predictable place.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  // Clamp the highlight when the result set shrinks as the query narrows.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const flat: SearchResult[] = useMemo(
    () => results.groups.flatMap((group) => group.results),
    [results],
  );

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_QUERY;

  function openResult(result: SearchResult) {
    onOpenChange(false);
    void navigate({ to: result.to });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (flat.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flat.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = flat[activeIndex];
      if (target) openResult(target);
    }
  }

  let running = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Search medicines, suppliers, staff and customers in this pharmacy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search medicines, suppliers, staff, customers…"
            aria-label="Search"
            className="h-12 border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          {query !== '' && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
          <Kbd className="hidden shrink-0 sm:inline-flex">Esc</Kbd>
        </div>

        <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
          {query.trim() === '' ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Type at least {MIN_QUERY} characters to search this pharmacy.
            </p>
          ) : tooShort ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Keep typing — {MIN_QUERY} characters or more.
            </p>
          ) : flat.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No matches for “{query.trim()}”.
            </p>
          ) : (
            results.groups.map((group) => {
              const Icon = ICON_FOR[group.category];
              return (
                <section key={group.category} className="mb-2 last:mb-0">
                  <h3 className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    <Icon className="size-3.5" />
                    {CATEGORY_LABEL[group.category]}
                    <span className="text-muted-foreground/70">({group.results.length})</span>
                  </h3>
                  <ul>
                    {group.results.map((result) => {
                      running += 1;
                      const index = running;
                      const active = index === activeIndex;
                      return (
                        <li key={`${result.category}-${result.id}`}>
                          <button
                            type="button"
                            // Highlight follows the keyboard cursor, not hover, so
                            // Enter always opens what is visibly selected.
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => openResult(result)}
                            className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${
                              active ? 'bg-muted text-foreground' : ''
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {result.title}
                              </span>
                              {result.subtitle && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {result.subtitle}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Building2 className="size-3.5" />
            This pharmacy only
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
