import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The canonical `cn`. Aliased as the bare specifier `cn` in vite + tsconfig,
 * which is how shadcn's base registry imports it in every component.
 * `~/lib/utils` re-exports this.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
