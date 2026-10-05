import { useEffect, useMemo, useState } from 'react';
import { Layers, Lock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Money } from '~/components/app/primitives';
import { formatCount, formatNaira, money } from '~/domain/money';
import { unitsUsedInHistory } from '~/domain/selectors';
import {
  findBaseUnit,
  formatStockQuantity,
  unitsBySize,
  validateUnitHierarchy,
} from '~/domain/units';
import type { Medicine, TradeUnit } from '~/domain/types';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';

export interface UnitEditorProps {
  medicine: Medicine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Suggests a key from the name: "Card (10)" -> "card", "Ampoule" -> "ampoule".
 *
 * Only a convenience for the owner typing a new unit. Uniqueness is enforced by
 * `validateUnitHierarchy`, not by this, and the owner can override it — some
 * pharmacies genuinely have two products called "Pack".
 */
function suggestKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\(.*$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? '' : cleaned;
}

/**
 * Packaging editor for one medicine.
 *
 * Reads its role from the store rather than taking a prop, so the same component
 * is correct wherever it is opened from. An assistant sees the configuration and
 * an explanation of why they cannot change it — not a set of mysteriously dead
 * inputs.
 *
 * Every number shown here comes from `src/domain/units.ts`. Nothing in this file
 * multiplies a multiplier, sorts by one, or validates one.
 */
export function UnitEditor({ medicine, open, onOpenChange }: UnitEditorProps) {
  const isOwner = usePharmacy((state) => state.currentUser.role === 'owner');
  // Only the slices the history check needs, rather than the whole store, so an
  // unrelated keystroke elsewhere does not re-render an open editor.
  const sales = usePharmacy((state) => state.sales);
  const receipts = usePharmacy((state) => state.stockReceipts);
  const { updateUnits } = usePharmacyActions();

  /** Units already transacted in, so their multiplier is locked. */
  const usedKeys = useMemo(
    () => unitsUsedInHistory({ sales, stockReceipts: receipts }, medicine.id),
    [sales, receipts, medicine.id],
  );

  const [draft, setDraft] = useState<TradeUnit[]>(medicine.units);
  /**
   * Keys added during this editing session.
   *
   * Only these track the name. An existing unit's key is frozen: sales and
   * receipts are keyed on it, so retyping a name must not silently look like
   * the old key was removed — which the historical guard would (correctly)
   * refuse, with a message about history rather than about a rename.
   */
  const [newKeys, setNewKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the dialog opens, so a cancelled edit leaves nothing behind
  // and an external change (another tab, a receipt approval) is not silently
  // overwritten by a stale draft.
  useEffect(() => {
    if (open) {
      setDraft(medicine.units);
      setNewKeys(new Set());
      setError(null);
      setSaving(false);
    }
  }, [open, medicine.units]);

  /** Base unit of the *draft*, falling back to the saved one while editing. */
  const baseUnit = findBaseUnit(draft) ?? findBaseUnit(medicine.units);
  const baseName = baseUnit?.name ?? 'base unit';

  // Smallest first, via the domain helper. A valid hierarchy always puts the
  // base unit here first because 1 is the smallest multiplier.
  const ordered = useMemo(() => unitsBySize(draft), [draft]);

  // The same validator the save path runs, so the warning and the refusal can
  // never disagree.
  const validation = useMemo(() => validateUnitHierarchy(draft), [draft]);
  const issues = validation.ok ? [] : validation.issues;

  const issueFor = (key: string): string | undefined =>
    issues.find((issue) => issue.unitKey === key)?.problem;

  const dirty = useMemo(() => {
    if (draft.length !== medicine.units.length) return true;
    return draft.some((unit, index) => {
      const before = medicine.units[index];
      if (!before) return true;
      return (
        before.key !== unit.key ||
        before.name !== unit.name ||
        before.multiplier !== unit.multiplier ||
        before.sellingPrice !== unit.sellingPrice
      );
    });
  }, [draft, medicine.units]);

  const patch = (key: string, changes: Partial<TradeUnit>) => {
    setDraft((current) =>
      current.map((unit) => (unit.key === key ? { ...unit, ...changes } : unit)),
    );
  };

  /** Renames a unit. New units also get their key derived from the name. */
  const renameUnit = (key: string, name: string) => {
    if (newKeys.has(key)) {
      const derived = suggestKey(name);
      // Only adopt the derived key when it is still unique; otherwise keep the
      // current one and let the duplicate-key validation explain the clash.
      const taken = draft.some((unit) => unit.key === derived && unit.key !== key);
      if (derived !== '' && !taken) {
        setNewKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          next.add(derived);
          return next;
        });
        setDraft((current) =>
          current.map((unit) =>
            unit.key === key ? { ...unit, name, key: derived } : unit,
          ),
        );
        return;
      }
    }
    patch(key, { name });
  };

  const addUnit = () => {
    // A key that cannot collide with anything already present, so adding a unit
    // is never blocked by a duplicate before the owner has typed a name.
    let key = 'unit';
    let n = 2;
    while (draft.some((unit) => unit.key === key)) key = `unit_${n++}`;

    setNewKeys((current) => new Set(current).add(key));
    setDraft((current) => [
      ...current,
      { key, name: '', multiplier: 1, sellingPrice: 0 },
    ]);
    setError(null);
  };

  const removeUnit = (unit: TradeUnit) => {
    if (unit.multiplier === 1) return; // base unit, guarded again at save time
    setDraft((current) => current.filter((entry) => entry.key !== unit.key));
    setNewKeys((current) => {
      const next = new Set(current);
      next.delete(unit.key);
      return next;
    });
    setError(null);
  };

  const save = () => {
    setError(null);

    // The database requires the base unit at index 0. Display order is by size,
    // which puts the base first for any valid hierarchy — but reorder explicitly
    // rather than relying on that coincidence.
    const base = findBaseUnit(draft);
    if (!base) {
      setError('One unit must convert to exactly 1 base unit.');
      return;
    }
    const orderedForSave = [base, ...draft.filter((unit) => unit.key !== base.key)];

    setSaving(true);
    const result = updateUnits(medicine.id, orderedForSave);

    if (!result.ok) {
      setError(result.error);
      setSaving(false);
      return;
    }

    setSaving(false);
    toast.success(`${medicine.name} packaging updated`, {
      description: result.value
        .map((unit) => `${unit.name} ×${unit.multiplier}`)
        .join(' · '),
    });
    onOpenChange(false);
  };

  const cancel = () => {
    setDraft(medicine.units);
    setNewKeys(new Set());
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : cancel())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="size-4" />
            Selling units
          </DialogTitle>
          <DialogDescription>
            {medicine.name} · {medicine.strength}. Customers can buy this medicine by different
            units. Stock is always tracked in the base unit
            {baseUnit ? ` (${baseUnit.name})` : ''}.
          </DialogDescription>
        </DialogHeader>

        {!isOwner && (
          <div className="flex items-start gap-2 rounded-lg border border-info-border bg-info-subtle p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-info" />
            <p className="text-info">
              Only an owner can change packaging. You can still sell this medicine in any of
              the units below.
            </p>
          </div>
        )}

        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {/* Column headings, desktop only. Below `sm` each unit becomes a
              stacked card, so nothing ever needs horizontal scroll. */}
          <div className="hidden grid-cols-[1fr_7rem_7rem_2.5rem] items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-table-head-foreground sm:grid">
            <span>Unit</span>
            <span className="text-right">Equals</span>
            <span className="text-right">Selling price</span>
            <span />
          </div>

          {ordered.map((unit) => {
            const isBase = unit.multiplier === 1;
            const locked = usedKeys.has(unit.key);
            const problem = issueFor(unit.key);
            const priceProblem = issues.find(
              (issue) => issue.unitKey === unit.key && issue.problem.includes('price'),
            )?.problem;

            return (
              <div
                key={unit.key}
                className={`grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_7rem_7rem_2.5rem] sm:items-center sm:gap-2 sm:p-2 ${
                  problem ? 'border-destructive/50 bg-destructive/5' : 'border-border'
                }`}
              >
                {/* --- name + key --- */}
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Label
                      htmlFor={`unit-name-${medicine.id}-${unit.key}`}
                      className="text-xs text-muted-foreground sm:sr-only"
                    >
                      Unit name
                    </Label>
                    <Input
                      id={`unit-name-${medicine.id}-${unit.key}`}
                      value={unit.name}
                      disabled={!isOwner || isBase}
                      placeholder="Card"
                      onChange={(event) => renameUnit(unit.key, event.target.value)}
                      className="h-8 min-w-0 flex-1"
                    />
                    {isBase && <Badge variant="brand">Base unit</Badge>}
                    {locked && !isBase && <Badge variant="neutral">In use</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    key: <span className="font-mono">{unit.key}</span>
                  </p>
                  {isBase && (
                    <p className="text-xs text-muted-foreground">
                      Always 1. Stock is counted in this unit.
                    </p>
                  )}
                  {locked && !isBase && (
                    <p className="text-xs text-muted-foreground">
                      Used in past sales or receipts, so its conversion is locked.
                    </p>
                  )}
                </div>

                {/* --- multiplier --- */}
                <div className="space-y-1">
                  <Label
                    htmlFor={`unit-mult-${medicine.id}-${unit.key}`}
                    className="text-xs text-muted-foreground sm:sr-only"
                  >
                    {baseName} per unit
                  </Label>
                  <Input
                    id={`unit-mult-${medicine.id}-${unit.key}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={unit.multiplier}
                    disabled={!isOwner || isBase || locked}
                    onChange={(event) => {
                      const raw = Number(event.target.value);
                      // Empty input must not become 0 or NaN in the draft.
                      patch(unit.key, {
                        multiplier: Number.isFinite(raw) ? raw : Number.NaN,
                      });
                    }}
                    className="h-8 text-right tabular"
                  />
                  <p className="text-xs text-muted-foreground sm:hidden">
                    {baseName} each
                  </p>
                </div>

                {/* --- selling price --- */}
                <div className="space-y-1">
                  <Label
                    htmlFor={`unit-price-${medicine.id}-${unit.key}`}
                    className="text-xs text-muted-foreground sm:sr-only"
                  >
                    Selling price
                  </Label>
                  <Input
                    id={`unit-price-${medicine.id}-${unit.key}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={Number.isFinite(unit.sellingPrice) ? unit.sellingPrice : ''}
                    disabled={!isOwner}
                    onChange={(event) => {
                      const raw = Number(event.target.value);
                      patch(unit.key, {
                        sellingPrice: Number.isFinite(raw) ? money(raw) : Number.NaN,
                      });
                    }}
                    className="h-8 text-right tabular"
                  />
                  <p
                    className="text-right text-xs text-muted-foreground sm:hidden"
                    data-numeric
                  >
                    {Number.isFinite(unit.sellingPrice)
                      ? formatNaira(unit.sellingPrice)
                      : '—'}{' '}
                    per {unit.name || 'unit'}
                  </p>
                </div>

                {/* --- remove --- */}
                <div className="flex justify-end">
                  {isBase ? (
                    <span
                      className="inline-flex size-8 items-center justify-center text-muted-foreground/50"
                      title="The base unit cannot be removed"
                    >
                      <Lock className="size-3.5" />
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      disabled={!isOwner || locked}
                      title={
                        locked
                          ? 'Used in past sales or receipts — create a new unit instead'
                          : `Remove ${unit.name || 'this unit'}`
                      }
                      onClick={() => removeUnit(unit)}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Remove {unit.name || 'unit'}</span>
                    </Button>
                  )}
                </div>

                {(problem || priceProblem) && (
                  <p className="col-span-full flex items-start gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                    {problem ?? priceProblem}
                  </p>
                )}
              </div>
            );
          })}

          {ordered.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              This product has no units configured. Add its base unit to start tracking stock.
            </p>
          )}
        </div>

        {/* Live "equals" preview + stock read in packaging terms. */}
        {baseUnit && ordered.length > 0 && (
          <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs">
            {ordered
              .filter((unit) => unit.multiplier > 1 && Number.isFinite(unit.multiplier))
              .map((unit) => (
                <p key={unit.key} data-numeric className="text-muted-foreground">
                  1 {unit.name || 'unit'} ={' '}
                  <span className="font-medium text-foreground">
                    {formatCount(unit.multiplier)} × {baseUnit.name}
                  </span>
                </p>
              ))}
            <p className="text-muted-foreground">
              {formatCount(medicine.totalQuantity)} × {baseUnit.name} on hand, shown as:{' '}
              <span className="font-medium text-foreground">
                {formatStockQuantity(medicine.units, medicine.totalQuantity, {
                  fallback: `0 × ${baseUnit.name}`,
                })}
              </span>
            </p>
            <p className="text-muted-foreground">
              Each unit is priced on its own — a box is not forced to cost 100 times a tablet.
            </p>
          </div>
        )}

        {issues.length > 0 && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {issues.length === 1 ? 'One problem to fix' : `${issues.length} problems to fix`}
              </p>
              <ul className="list-inside list-disc text-xs">
                {issues.map((issue) => (
                  <li key={`${issue.unitKey}-${issue.problem}`}>
                    {issue.unitName ? `${issue.unitName}: ` : ''}
                    {issue.problem}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="mr-auto"
            disabled={!isOwner}
            onClick={addUnit}
          >
            <Plus />
            Add unit
          </Button>
          <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={!isOwner || saving || !validation.ok || !dirty}
          >
            {saving ? 'Saving…' : 'Save units'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
