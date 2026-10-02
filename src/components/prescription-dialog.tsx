import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Camera,
  Check,
  FileImage,
  Loader,
  Plus,
  RotateCcw,
  ScanText,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import { Field, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { cn } from '~/lib/utils';
import { getAiStatus, readPrescription } from '~/lib/gemini';
import type { GeminiError, PrescriptionMedication } from '~/domain/gemini';

/**
 * Prescription capture.
 *
 * The flow is deliberately confirm-before-commit. A model reading a doctor's
 * handwriting is a *draft*, not a result — dosing errors are the highest
 * consequence mistake this app can help someone make. So nothing reaches the
 * cart until a person has looked at every line and ticked it.
 *
 * When no API key is configured this does not pretend. It says so, says what
 * to set, and leaves the manual path fully usable — a counter with no AI
 * configured must still be able to dispense.
 */

type Phase = 'idle' | 'reading' | 'review' | 'failed';

/** Longest edge, in pixels. Keeps the request body small enough to stay fast. */
const MAX_EDGE = 1400;

/** Downstream cap. A phone camera produces far more than a model needs. */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

export interface PrescriptionDraft {
  name: string;
  strength: string;
  quantity: number;
}

export interface PrescriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Handed the confirmed lines. Resolution against real products is the
   * caller's job — this component has no knowledge of the medicine catalogue.
   */
  onConfirm: (items: PrescriptionDraft[]) => void;
}

export function PrescriptionDialog({
  open,
  onOpenChange,
  onConfirm,
}: PrescriptionDialogProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<GeminiError | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [setupHint, setSetupHint] = useState<string | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [manualName, setManualName] = useState('');
  const [manualQuantity, setManualQuantity] = useState('1');

  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const manualId = useId();

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setPreview(null);
    setHint('');
    setRows([]);
    setManualName('');
    setManualQuantity('1');
  }, []);

  // Ask whether AI is even configured *before* offering it, so nobody
  // photographs a script only to be told the feature is off.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void getAiStatus().then((status) => {
      if (cancelled) return;
      setAiEnabled(status.configured);
      setSetupHint(status.setup ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  /* ------------------------------------------------------------------ image */

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        setError({ error: 'That file is not an image.', code: 'bad_request' });
        setPhase('failed');
        return;
      }

      if (file.size > MAX_FILE_BYTES) {
        setError({
          error: 'That image is larger than 12MB. Take a smaller photo.',
          code: 'bad_request',
        });
        setPhase('failed');
        return;
      }

      setError(null);
      setPhase('reading');

      try {
        const dataUrl = await downscale(file);
        setPreview(dataUrl);

        const result = await readPrescription({ image: dataUrl, ...(hint.trim() ? { hint: hint.trim() } : {}) });

        if (!result.ok) {
          setError(result.error);
          setPhase('failed');
          return;
        }

        const extracted = result.data.medications;
        if (extracted.length === 0) {
          setError({
            error: result.data.legible
              ? 'No medications were read from that image. Try a closer, better-lit shot.'
              : 'That image is too unclear to read. Retake it closer, in better light, or enter the items manually.',
            code: 'bad_model_output',
          });
          setPhase('failed');
          return;
        }

        setRows(extracted.map(toRow));
        setPhase('review');
      } catch (cause) {
        setError({
          error: cause instanceof Error ? cause.message : 'Could not read that image.',
          code: 'unknown',
        });
        setPhase('failed');
      }
    },
    [hint],
  );

  const retake = () => {
    reset();
  };

  /* ------------------------------------------------------------------ rows */

  const addManualRow = () => {
    const name = manualName.trim();
    if (!name) return;
    setRows((current) => [
      ...current,
      {
        id: `manual-${Date.now()}-${current.length}`,
        name,
        strength: '',
        dosageForm: '',
        quantity: Math.max(1, Math.trunc(Number(manualQuantity) || 1)),
        directions: '',
        confidence: 'high',
        included: true,
        manual: true,
      },
    ]);
    setManualName('');
    setManualQuantity('1');
  };

  const confirmed = rows.filter((row) => row.included);
  const canConfirm = confirmed.length > 0;

  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(
      confirmed.map((row) => ({
        name: row.name,
        strength: row.strength,
        quantity: row.quantity,
      })),
    );
    reset();
    onOpenChange(false);
  };

  const notConfigured = error?.code === 'no_api_key';
  const aiOff = aiEnabled === false || notConfigured;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanText className="size-4" />
            Read prescription
          </DialogTitle>
          <DialogDescription>
            Photograph or upload a script. Every line is checked by you before anything is added.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {aiOff && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Prescription OCR is not configured</AlertTitle>
              <AlertDescription>
                <p>
                  This pharmacy has no <code className="font-mono text-xs">GEMINI_API_KEY</code>, so
                  scripts cannot be read automatically.
                </p>
                <p className="mt-1.5">
                  To enable it, set the secret and redeploy:
                </p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  <li>
                    <code className="font-mono text-xs">wrangler secret put GEMINI_API_KEY</code>
                  </li>
                  <li>or add it to .dev.vars for local development</li>
                </ul>
                <p className="mt-1.5">
                  You can still add the items by hand below.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {/* Only when the probe itself was inconclusive — otherwise the alert
              above already carries the setup instructions. */}
          {setupHint && aiEnabled === null && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>AI status unknown</AlertTitle>
              <AlertDescription>{setupHint}</AlertDescription>
            </Alert>
          )}

          {phase === 'reading' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader className="size-4 animate-spin" />
              Reading the script…
            </p>
          )}

          {error && !notConfigured && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Could not read the script</AlertTitle>
              <AlertDescription>{error.error}</AlertDescription>
            </Alert>
          )}

          {preview && (
            <div className="relative overflow-hidden rounded-lg border border-border">
              {/* Data URL from a local file, downscaled. Not remote content. */}
              <img
                src={preview}
                alt="Prescription being read"
                className="max-h-56 w-full bg-muted object-contain"
              />
              <Button
                variant="secondary"
                size="sm"
                className="absolute top-2 right-2"
                onClick={retake}>
                <RotateCcw />
                Retake
              </Button>
            </div>
          )}

          {(phase === 'idle' || phase === 'failed') && !aiOff && (
            <div className="grid gap-2 sm:grid-cols-2">
              {/* `capture` asks the OS for the rear lens on mobile. */}
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(event) => {
                  void handleFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(event) => {
                  void handleFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />

              <Button variant="outline" className="h-11" onClick={() => cameraRef.current?.click()}>
                <Camera />
                Take photo
              </Button>
              <Button variant="outline" className="h-11" onClick={() => fileRef.current?.click()}>
                <FileImage />
                Upload
              </Button>
            </div>
          )}

          {phase === 'review' && (
            <ul className="space-y-1.5" aria-label="Extracted medications">
              {rows.map((row) => (
                <li key={row.id}>
                  <RowToggle
                    row={row}
                    onToggle={() =>
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, included: !item.included } : item,
                        ),
                      )
                    }
                    onRemove={
                      row.manual
                        ? () => setRows((current) => current.filter((item) => item.id !== row.id))
                        : undefined
                    }
                    onQuantityChange={(quantity) =>
                      setRows((current) =>
                        current.map((item) => (item.id === row.id ? { ...item, quantity } : item)),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          {/* Manual entry is always reachable, including mid-review. */}
          {phase !== 'reading' && (
            <Field>
              <FieldLabel htmlFor={manualId} className="text-muted-foreground">
                Add an item by hand
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={manualId}
                  value={manualName}
                  onChange={(event) => setManualName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addManualRow();
                    }
                  }}
                  placeholder="Amoxicillin 500mg"
                />
                <Input
                  value={manualQuantity}
                  onChange={(event) => setManualQuantity(event.target.value)}
                  inputMode="numeric"
                  className="w-20 text-center"
                  aria-label="Quantity"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9"
                  onClick={addManualRow}
                  disabled={manualName.trim().length === 0}
                  aria-label="Add item">
                  <Plus />
                </Button>
              </div>
            </Field>
          )}

          {/* Optional context. Helps the reader disambiguate an unclear name. */}
          {phase !== 'reading' && (
            <Field>
              <FieldLabel htmlFor={hintId} className="text-muted-foreground">
                Anything the patient said
              </FieldLabel>
              <Textarea
                id={hintId}
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                placeholder="Fever and cough for four days"
                className="min-h-14"
              />
            </Field>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!canConfirm}>
            <Check />
            {canConfirm
              ? `Add ${confirmed.length} ${confirmed.length === 1 ? 'item' : 'items'}`
              : 'Add items'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------- rows */

/**
 * A review row. Narrows `quantity` to a number, because a row the attendant
 * has not yet corrected still has to render and be confirmed — a `null` here
 * would surface as an empty box rather than a "fill this in" prompt.
 */
interface Row extends Omit<PrescriptionMedication, 'quantity'> {
  id: string;
  quantity: number;
  /** Kept when the user ticks the row. */
  included: boolean;
  manual: boolean;
}

function toRow(medication: PrescriptionMedication, index: number): Row {
  return {
    ...medication,
    quantity: medication.quantity ?? 1,
    id: `rx-${index}-${medication.name}`,
    // Everything starts ticked, but a low-confidence read is badged so it is
    // visibly the one that needs a second look before it is dispensed.
    included: true,
    manual: false,
  };
}

function RowToggle({
  row,
  onToggle,
  onRemove,
  onQuantityChange,
}: {
  row: Row;
  onToggle: () => void;
  onRemove?: () => void;
  onQuantityChange: (quantity: number) => void;
}) {
  const uncertain = !row.manual && row.confidence !== 'high';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border p-2.5',
        !row.included && 'opacity-50',
      )}>
      <Button
        variant={row.included ? 'default' : 'outline'}
        size="icon-sm"
        onClick={onToggle}
        aria-label={row.included ? `Exclude ${row.name}` : `Include ${row.name}`}
        aria-pressed={row.included}
        className="shrink-0">
        <Check />
      </Button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[row.strength, row.dosageForm, row.directions].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>

      {uncertain && (
        <Badge variant="warning" className="shrink-0">
          {row.confidence === 'low' ? 'Check' : 'Unsure'}
        </Badge>
      )}

      {row.included && (
        <Input
          value={String(row.quantity)}
          onChange={(event) =>
            onQuantityChange(Math.max(1, Math.trunc(Number(event.target.value) || 1)))
          }
          inputMode="numeric"
          className="h-8 w-14 shrink-0 text-center"
          aria-label={`Quantity for ${row.name}`}
        />
      )}

      {onRemove && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Remove ${row.name}`}
          className="shrink-0 text-muted-foreground">
          <X />
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ image */

/**
 * Downscale to a data URL.
 *
 * Two reasons this is not just `FileReader`: a modern phone camera produces
 * 4–12MB, which is a slow upload and a large Worker request body for no
 * benefit, and `canvas.toDataURL('image/jpeg')` normalises to a format the
 * Worker is guaranteed to accept.
 */
function downscale(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const image = new Image();

      image.onerror = () => reject(new Error('That file is not a readable image.'));
      image.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('This browser cannot process the image.'));
          return;
        }

        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };

      image.src = String(reader.result);
    };

    reader.readAsDataURL(file);
  });
}
