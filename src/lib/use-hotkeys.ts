import { useEffect, useRef } from 'react';

/**
 * A single keybinding, e.g. `mod+enter`, `/`, `shift+/`, `f2`.
 *
 * `mod` is ⌘ on Apple platforms and Ctrl elsewhere, so one binding covers both.
 * Modifiers are order-independent and a binding only fires when *every*
 * declared modifier is held and no undeclared one is.
 */
export type Hotkey = string;

type Options = {
  /** Fire even while a text field has focus. Off by default so shortcuts
   *  never eat keystrokes someone is typing. */
  allowInInput?: boolean;
  /** Set false to detach without unmounting the caller. */
  enabled?: boolean;
  /** Fires when the combination is pressed. Return true to call preventDefault. */
  handler: (event: KeyboardEvent) => void | boolean;
};

const MOD_ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const;

function parse(hotkey: Hotkey) {
  const parts = hotkey.toLowerCase().split('+').map((part) => part.trim());
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).filter(Boolean));

  // The key itself may legitimately be a modifier-free token like `+`.
  if (!key) return null;

  return { key, mods };
}

function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function modifiersMatch(event: KeyboardEvent, mods: Set<string>) {
  const mod = isMac() ? event.metaKey : event.ctrlKey;

  for (const name of MOD_ORDER) {
    const held =
      name === 'mod' ? mod : name === 'ctrl' ? event.ctrlKey : name === 'meta' ? event.metaKey : name === 'alt' ? event.altKey : event.shiftKey;

    // `mod` is an alias, so accept either physical key when it is the only
    // modifier requested and no sibling was named.
    const satisfied = name === 'mod' && mods.size === 1 ? mod : held;
    if (satisfied !== mods.has(name)) return false;
  }

  return true;
}

/**
 * Bind document-level shortcuts.
 *
 * Kept deliberately tiny: no context providers, no dependency, no chord
 * sequences. It covers the cases this app actually needs (single keys,
 * one modifier, and `mod+key`).
 */
export function useHotkeys(map: Record<Hotkey, Options | ((event: KeyboardEvent) => void)>) {
  const latest = useRef(map);
  latest.current = map;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = isEditable(event.target);

      for (const [hotkey, raw] of Object.entries(latest.current)) {
        const parsed = parse(hotkey);
        if (!parsed) continue;

        const options: Options = typeof raw === 'function' ? { handler: raw } : raw;
        if (options.enabled === false) continue;

        // `event.key` for a bare `/` is `/`; with Shift held it is `?`, which
        // is why `shift+/` is the correct spelling for the cheatsheet.
        const pressed = event.key.toLowerCase();
        if (pressed !== parsed.key && `/${pressed}` !== `/${parsed.key}`) continue;

        if (!modifiersMatch(event, parsed.mods)) continue;
        if (editable && !options.allowInInput) continue;

        if (options.handler(event) !== false) event.preventDefault();
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}