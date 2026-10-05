import type { RealtimeChannel } from '@supabase/supabase-js';
import type { StockMovementRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';

/**
 * Live stock updates.
 *
 * Why `stock_movements` and not `medicines`
 * ----------------------------------------
 * The previous phase dropped `medicines` and `stock_receipts` from the realtime
 * publication, and that stands — but it left live stock broken. Realtime's
 * `postgres_changes` filters rows by RLS and does NOT honour column grants, so
 * publishing a table that holds `cost_per_base_unit` hands an assistant the
 * purchase price the grant section exists to withhold. `medicine_batches` has the
 * same problem.
 *
 * `stock_movements` has no cost column and no branch secret: medicine, batch,
 * quantity, time. Subscribing to it gives every till the signal that something
 * moved, which is enough to re-fetch the affected products and see another
 * counter's sale. Same live behaviour, nothing sensitive in the payload.
 *
 * The subscription is RLS-scoped like any other read, so a movement in another
 * branch is never delivered.
 */

export type StockEvent =
  | { kind: 'movement'; movement: StockMovementRow }
  | { kind: 'error'; message: string };

/**
 * Subscribe to stock movement. Returns an unsubscribe function.
 *
 * The callback receives the medicine and batch ids rather than the full row so a
 * caller refetches what it needs, instead of rendering a ledger entry in place of
 * a product list.
 */
export async function subscribeToStockChanges(
  onEvent: (event: StockEvent) => void,
): Promise<(() => void) | null> {
  if (!isSupabaseConfigured()) return null;
  if (!(await hasSession())) return null;

  let channel: RealtimeChannel;
  try {
    channel = client()
      .channel('pf-stock')
      .on<StockMovementRow>(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'stock_movements' },
        (payload) => {
          const movement = payload.new as StockMovementRow;
          onEvent({ kind: 'movement', movement });
        },
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onEvent({ kind: 'error', message: `Stock live updates unavailable (${status})` });
        }
      });
  } catch {
    return null;
  }

  return () => {
    void client().removeChannel(channel);
  };
}