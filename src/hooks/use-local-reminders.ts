import { useCallback, useEffect, useState } from 'react';

/**
 * Device-local refill notes.
 *
 * THIS IS NOT DATA. It never touches `src/store/pharmacy.ts` and the pharmacy
 * cannot see it. It is a per-medicine reminder note a patient keeps on their own
 * phone — the sort of thing you stick on the fridge — so the one genuinely
 * useful thing the customer side can do without a backend is done somewhere it
 * cannot be mistaken for a real record.
 *
 * Storage rules this follows:
 *   - never read `localStorage` during render (the server has none, and reading
 *     it would desynchronise hydration), so the load happens in an effect and
 *     `loaded` gates the UI;
 *   - corrupt or foreign payloads are discarded rather than crashing the page.
 */

const STORAGE_KEY = 'pharmaflow:portal:reminders:v1';

export interface LocalReminder {
  medicineId: string;
  /** Free text the patient wrote for themselves. */
  note: string;
  /** ISO timestamp of when it was last edited on this device. */
  savedAt: string;
}

function isReminder(value: unknown): value is LocalReminder {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<LocalReminder>;
  return (
    typeof entry.medicineId === 'string' &&
    typeof entry.note === 'string' &&
    typeof entry.savedAt === 'string'
  );
}

function read(): LocalReminder[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReminder);
  } catch {
    return [];
  }
}

function write(reminders: LocalReminder[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
  } catch {
    // Private mode or quota. The screen keeps working in memory for this
    // visit, which is the honest degradation.
  }
}

export function useLocalReminders() {
  const [reminders, setReminders] = useState<LocalReminder[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setReminders(read());
    setLoaded(true);
  }, []);

  const save = useCallback((medicineId: string, note: string) => {
    setReminders((current) => {
      const trimmed = note.trim();
      const next = current.filter((entry) => entry.medicineId !== medicineId);
      const updated = trimmed
        ? [
            ...next,
            { medicineId, note: trimmed, savedAt: new Date().toISOString() },
          ]
        : next;

      write(updated);
      return updated;
    });
  }, []);

  const clear = useCallback(() => {
    setReminders([]);
    write([]);
  }, []);

  return { reminders, loaded, save, clear };
}
