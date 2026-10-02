import { Moon, Sun } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { clearStoredTheme, useTheme } from '~/lib/theme';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Change theme"
          />
        }
      >
        {/* Both icons are in the DOM; CSS picks one, so no icon swap flash. */}
        <Sun className="size-4 dark:hidden" />
        <Moon className="hidden size-4 dark:block" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme(clearStoredTheme())}>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
