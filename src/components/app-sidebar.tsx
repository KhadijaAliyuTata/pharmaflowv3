import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut, Plus, ShieldCheck, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { BRAND, ROLE_LABEL, sectionsForRole } from '~/lib/nav';
import { useBranchName } from '~/lib/supabase/branch-context';
import { DEMO_ACCOUNTS, isDemoMode, signOut, switchRole, useSession } from '~/lib/session';
import type { Role } from '~/domain/types';

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  /** Overrides the signed-in name. Only for previews. */
  userName?: string;
  branchName?: string;
}

/**
 * Sidebar structure follows the shadcn `sidebar-01` block: header with brand,
 * grouped nav, footer with user. The block's demo data is replaced by
 * `~/lib/nav`, so sidebar, ⌘K and breadcrumbs cannot disagree.
 *
 * `collapsible="offcanvas"` (from the block) because this app is dense — a
 * rail of icons would be unreadable at these label lengths.
 *
 * The nav reads the session directly rather than taking a `role` prop. A prop
 * meant every consumer had to remember to thread it, and forgetting it silently
 * showed an assistant the owner's menu.
 */
export function AppSidebar({
  userName,
  branchName = BRAND.defaultBranch,
  ...props
}: AppSidebarProps) {
  const { user } = useSession();
  const navigate = useNavigate();

  // `owner` while loading, matching the server. The store's `currentUser` is
  // what the screens themselves gate on, so the two agree after mount.
  const role: Role = user?.role ?? 'owner';
  const name = userName ?? user?.name ?? 'Signed out';
  // Compatibility boundary: prefer the branch Supabase resolved, fall back to the
  // prototype's own (localStorage) value. Display only - never a security input.
  const resolvedBranchName = useBranchName();
  const sections = sectionsForRole(role);

  const onSignOut = () => {
    signOut();
    void navigate({ to: '/login' });
  };

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/" />}
            >
              <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-7 items-center justify-center rounded-md text-xs font-bold">
                {BRAND.mark}
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold">{BRAND.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {resolvedBranchName ?? branchName}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button
          className="mt-1 w-full justify-start"
          size="lg"
          render={<Link to={BRAND.newSaleTo} />}
        >
          <Plus />
          {BRAND.newSaleLabel}
        </Button>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      render={<Link to={item.to} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.badge ? (
                      <SidebarMenuBadge>
                        <Badge variant="secondary" className="px-1.5 tabular">
                          {item.badge}
                        </Badge>
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Name and role sit next to a sign-out button rather than behind a
                dropdown. Hiding "sign out" under the avatar meant it was invisible
                on a phone — the sidebar is a closed sheet there — and invisible
                whenever the sidebar is collapsed to icons. The dropdown is kept
                for the demo-only role switch, which stays a menu. */}
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      className="min-w-0 flex-1 data-open:hover:bg-sidebar-accent"
                    />
                  }
                >
                  <Avatar className="size-7 rounded-md">
                    <AvatarFallback className="text-xs">
                      {initials(name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {ROLE_LABEL[role]}
                    </span>
                  </div>
                </DropdownMenuTrigger>

                <DropdownMenuContent align="start" side="top" className="w-56">
                  {/* Every label and item sits inside a Group or a RadioGroup.
                      Base UI throws on a `MenuGroupLabel` that has no group
                      parent, and it takes the whole route down with it. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{name}</DropdownMenuLabel>
                  </DropdownMenuGroup>

                  {/* Demo only. Real role changes are an audited action, not a
                      self-service dropdown. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Act as</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={role}
                      onValueChange={(value) => {
                        // Only available in demo mode. With Supabase, a role is
                        // a row in `profiles` guarded by RLS — a self-service
                        // switch would let anyone promote themselves.
                        const next: Role = value;
                        switchRole(next);
                        toast.success(`Viewing as ${ROLE_LABEL[next]}`);
                      }}
                    >
                      {DEMO_ACCOUNTS.map((account) => (
                        <DropdownMenuRadioItem key={account.role} value={account.role}>
                          <UserRound />
                          {ROLE_LABEL[account.role]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Sits beside the name at every sidebar width. When the sidebar is
                  collapsed to icons the text is hidden but the button remains,
                  so signing out never becomes unreachable. */}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Sign out"
                title="Sign out"
                onClick={onSignOut}
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>

        <p className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-3" />
          Demo build
        </p>
        <SidebarRail />
      </SidebarFooter>
    </Sidebar>
  );
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}