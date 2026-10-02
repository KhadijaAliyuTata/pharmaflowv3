import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Bell, Search } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb';
import { Button } from '~/components/ui/button';
import { Separator } from '~/components/ui/separator';
import { SidebarTrigger } from '~/components/ui/sidebar';
import { Kbd } from '~/components/ui/kbd';
import { ThemeToggle } from '~/components/theme-toggle';
import { findNavItem, type Role } from '~/lib/nav';

/**
 * Header per the shadcn sidebar-01 block: trigger, separator, breadcrumb.
 * Plus the pieces v2's Navbar had: global search, notifications, theme.
 *
 * The breadcrumb is derived from the current pathname via `~/lib/nav`, not from
 * a hand-maintained label map.
 */
export function AppHeader({
  role = 'owner',
  onOpenCommand,
}: {
  role?: Role;
  onOpenCommand: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = findNavItem(pathname);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />

      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink render={<a href="/" />}>PharmaFlow</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden md:block" />
          <BreadcrumbItem>
            <BreadcrumbPage>{current?.label ?? 'Dashboard'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1">
        {/* Renders as a button; ⌘K handling lives in the CommandMenu. */}
        <Button
          variant="outline"
          size="sm"
          className="hidden h-8 gap-2 text-muted-foreground md:flex"
          onClick={onOpenCommand}
        >
          <Search className="size-3.5" />
          Search
          <Kbd className="ml-1">{isMac ? '⌘' : 'Ctrl '}K</Kbd>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="size-8 md:hidden"
          aria-label="Search"
          onClick={onOpenCommand}
        >
          <Search className="size-4" />
        </Button>

        <Button variant="ghost" size="icon" className="size-8" aria-label="Notifications">
          <Bell className="size-4" />
        </Button>

        <ThemeToggle />
      </div>
    </header>
  );
}
