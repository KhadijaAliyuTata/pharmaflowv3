import { useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Bell, Command, LogOut, Search, Store } from 'lucide-react';
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Separator } from '~/components/ui/separator';
import { SidebarTrigger } from '~/components/ui/sidebar';
import { Kbd } from '~/components/ui/kbd';
import { ThemeToggle } from '~/components/theme-toggle';
import { findNavItem, ROLE_LABEL, type Role } from '~/lib/nav';
import { signOut, useSession } from '~/lib/session';
import {
  activeBranch,
  hasMultipleBranches,
  switchActiveBranch,
  useActiveBranch,
} from '~/lib/supabase/branch-context';

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
  onOpenSearch,
  onOpenCommand,
}: {
  role?: Role;
  /** Opens the record search (medicines, suppliers, staff, customers). */
  onOpenSearch: () => void;
  /** Opens the screen-jump palette (⌘K). */
  onOpenCommand: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = findNavItem(pathname);
  const [isMac, setIsMac] = useState(false);
  const { user } = useSession();
  const { currentBranchId, availableBranches } = useActiveBranch();
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
        {/* Record search. This is the real search over medicines, suppliers,
            staff and customers — independent of the theme toggle, which lives
            two buttons along and is never wired to this control. */}
        <Button
          variant="outline"
          size="sm"
          className="hidden h-8 gap-2 text-muted-foreground md:flex"
          onClick={onOpenSearch}
        >
          <Search className="size-3.5" />
          Search
          <Kbd className="ml-1">/</Kbd>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="size-8 md:hidden"
          aria-label="Search"
          onClick={onOpenSearch}
        >
          <Search className="size-4" />
        </Button>

        {/* Screen-jump palette, kept on ⌘K so the previous shortcut still works.
            It is a separate control from record search, not the same one. */}
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 lg:inline-flex"
          aria-label={`Go to screen (${isMac ? 'Command' : 'Ctrl'} K)`}
          onClick={onOpenCommand}
        >
          <Command className="size-4" />
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

          <DropdownMenuContent align="end" className="w-60">
            {/* Base UI requires every label to sit inside a Group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{name}</DropdownMenuLabel>
            </DropdownMenuGroup>

            {/* Multi-branch. Renders only when this session may open more than one
                counter, so a single-branch pharmacy sees exactly what it saw
                before. The list comes from `pf_my_branches`, so it cannot contain
                a branch this session is not entitled to. */}
            {hasMultipleBranches() && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Branch</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={currentBranchId ?? ''}
                  onValueChange={(value) => {
                    void (async () => {
                      const next = await switchActiveBranch(value);
                      if (!next.ok) {
                        toast.error(next.error);
                        return;
                      }
                      toast.success(`Switched to ${activeBranch()?.name ?? 'branch'}`);
                    })();
                  }}
                >
                  {availableBranches.map((branch) => (
                    <DropdownMenuRadioItem key={branch.id} value={branch.id}>
                      <Store />
                      <span className="truncate">{branch.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {ROLE_LABEL[branch.role]}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )}

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
