import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { itemsForRole, type Role } from '~/lib/nav';

/**
 * ⌘K palette over the installed `command` + `dialog` primitives.
 *
 * ## This navigates screens. It does not search records.
 *
 * Those are two different jobs and the app now keeps them in two different
 * components:
 *
 *  - **This** (`mod+k`) jumps to a screen.
 *  - `~/components/app/global-search.tsx` searches medicines, suppliers, staff
 *    and customers, and is what the header's search control opens.
 *
 * ## Why there is no theme item here
 *
 * There used to be a "Preferences → Switch to light/dark" row bound to
 * `toggleTheme`. It was reachable by typing anything in the header's search
 * control, because that control opened this palette — so a search could flip the
 * application's theme, which is both surprising and a genuine bug. The theme is
 * now changed in exactly one place, `ThemeToggle` in the header, and neither
 * this palette nor the global search imports the theme at all. Keeping the
 * control out of the palette makes "searching changes the theme" structurally
 * impossible rather than merely unlikely.
 *
 * Filtering is done here rather than by the primitive (`shouldFilter={false}`)
 * because the haystack includes each item's extra `keywords`, which
 * Command's default matcher does not know about.
 */
export function CommandMenu({
  open,
  onOpenChange,
  role = 'owner',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role?: Role;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  // Clear the query on close so the palette never reopens mid-search.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const items = useMemo(() => itemsForRole(role), [role]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.label, ...(item.keywords ?? [])].join(' ').toLowerCase().includes(needle),
    );
  }, [items, query]);

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Go to screen"
      description="Jump to a screen. To search records, use the search control in the header."
    >
      {/* shouldFilter lives on Command, not CommandDialog — the dialog is
          only a Dialog wrapper. cmdk's matcher does not know about our extra
          `keywords`, so filtering is done above. */}
      <Command shouldFilter={false} value={query} onValueChange={setQuery}>
        <CommandInput placeholder="Search screens…" />
        <CommandList>
          <CommandEmpty>No screens match “{query}”.</CommandEmpty>

          <CommandGroup heading="Screens">
            {matches.map((item) => (
              <CommandItem
                key={item.to}
                value={item.to}
                onSelect={() => run(() => void navigate({ to: item.to }))}
              >
                <item.icon />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
