/**
 * Loads the POS device panel's durable sale states without collapsing a
 * storage failure into "no sales".
 */

import { classifyStorageError, type OfflineRepo } from './local-db';
import {
  confirmedSales,
  pendingSalesView,
  type ConfirmedSaleView,
  type PendingSaleView,
} from './pos-offline';

export interface DeviceSales {
  pending: PendingSaleView[];
  needsAttention: PendingSaleView[];
  conflicts: PendingSaleView[];
  confirmed: ConfirmedSaleView[];
}

export function emptyDeviceSales(): DeviceSales {
  return { pending: [], needsAttention: [], conflicts: [], confirmed: [] };
}

export type DeviceSalesLoad =
  | { ok: true; data: DeviceSales }
  | { ok: false; error: string };

function readFailureMessage(error: unknown): string {
  switch (classifyStorageError(error)) {
    case 'blocked':
      return 'The saved sales are blocked by another tab. Close other tabs and reload before relying on the device panel.';
    case 'quota':
      return 'The device is out of storage, so the saved sales could not be read.';
    case 'version':
      return 'The device storage version is incompatible. Reload the page before relying on the device panel.';
    default:
      return 'The sales saved on this device could not be read. Do not assume the panel is empty.';
  }
}

export async function loadDeviceSales(repo: OfflineRepo): Promise<DeviceSalesLoad> {
  try {
    const [view, confirmed] = await Promise.all([
      pendingSalesView(repo),
      confirmedSales(repo),
    ]);
    return {
      ok: true,
      data: {
        pending: view.pending,
        needsAttention: view.needsAttention,
        conflicts: view.conflicts,
        confirmed,
      },
    };
  } catch (error) {
    return { ok: false, error: readFailureMessage(error) };
  }
}
