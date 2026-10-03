import { useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Bell, LogOut, Search } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Separator } from '~/components/ui/separator';
import { SidebarTrigger } from '~/components/ui/sidebar';
import { Kbd } from '~/components/ui/kbd';
import { ThemeToggle } from '~/components/theme-toggle';
import { findNavItem, type Role } from '~/lib/nav';
import { signOut, useSession } from '~/lib/session';

/** Same two-letter treatment the sidebar footer uses, so the two match. */
function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Header per the shadcn sidebar-01 block: trigger, separator, breadcrumb.
 * Plus the pieces v2's Navbar had: global search, notifications, theme.
 * And an account menu, so signing out does not depend on finding the sidebar.
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
  const { user } = useSession();
  const navigate = useNavigate();
  const name = user?.name ?? 'Signed in';

  // The sidebar already has a sign-out in its footer, but on a phone the sidebar
  // is a closed sheet, so that button is unreachable without opening it. The
  // header is the one chrome element present on every screen at every width, so
  // it carries the account menu too. Both call the same `signOut`.
  const onSignOut = () => {
    signOut();
    void navigate({ to: '/login' });
  };

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

        {/* Account menu. Icon-only on small screens so it does not crowd the
            search and theme controls; the avatar fallback always shows initials,
            so there is something to tap. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                aria-label={`Account menu for ${name}`}
              />
            }
          >
            <Avatar className="size-6 rounded-full">
              <AvatarFallback className="text-[10px]">{initials(name)}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            {/* Base UI requires every label to sit inside a Group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{name}</DropdownMenuLabel>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={onSignOut}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
