import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Moon, Sun } from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '~/components/ui/command';
import { itemsForRole, type Role } from '~/lib/nav';
import { useTheme } from '~/lib/theme';

/**
 * ⌘K palette over the installed `command` + `dialog` primitives.
 *
 * v2's Navbar advertised "Search medicines, transactions, staff... (⌘K)" in its
 * placeholder but had no implementation behind it. This delivers the screen
 * half of it; record-level search arrives with the ported screens.
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
  const { theme, toggleTheme } = useTheme();
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
      title="Command menu"
      description="Jump to a screen or change a preference"
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

          <CommandSeparator />

          <CommandGroup heading="Preferences">
            <CommandItem value="toggle-theme" onSelect={() => run(toggleTheme)}>
              {theme === 'dark' ? <Sun /> : <Moon />}
              Switch to {theme === 'dark' ? 'light' : 'dark'}
              <CommandShortcut>T</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
