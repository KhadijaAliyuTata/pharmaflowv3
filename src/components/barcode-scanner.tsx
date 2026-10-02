import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, CameraOff, Keyboard, ScanLine, TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import { Field, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { cn } from '~/lib/utils';

/**
 * Camera barcode scanner.
 *
 * Built on the native `BarcodeDetector` rather than a decoding library:
 *   - no new dependency (the brief forbids adding any), and
 *   - on Chromium the decode runs off the main thread, so a scan does not
 *     stutter the cart.
 *
 * Safari and Firefox do not ship `BarcodeDetector` at all. Rather than pull in
 * a JS decoder to cover them, this degrades to a manual entry field. That is a
 * deliberate trade: a barcode that the attendant can type in is a worse
 * experience than scanning, not a broken one, and it needs no extra bytes.
 *
 * The camera is the scarce resource here. A `MediaStream` whose tracks are
 * never stopped keeps the camera light on and holds the device against other
 * apps, so `stopStream` runs on close, on unmount, and on every error path.
 */

/* -------------------------------------------------------------- the Web API */

/**
 * `BarcodeDetector` is still absent from TypeScript's DOM lib. These are the
 * two members actually used; declaring them narrowly means a future lib.dom
 * addition will surface as a conflict here rather than silently shadowing.
 */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
}

function getDetectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null;
  if (!('BarcodeDetector' in window)) return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector ?? null;
}

/** Retail pharmacy formats. A generic `formats` list is not supported everywhere. */
const FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
];

/** ~2 frames at 30fps. Long enough to stop one barcode firing twice. */
const RESCAN_LOCK_MS = 1500;

const IDLE_POLL_MS = 120;

type ScanState =
  /** Waiting for `getUserMedia` to resolve. */
  | 'starting'
  | 'scanning'
  | 'denied'
  | 'nocamera'
  | 'busy'
  | 'insecure'
  | 'unsupported'
  | 'failed';

export interface BarcodeScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once per accepted read, with the raw barcode. */
  onDetected: (code: string) => void;
  /** Which camera to prefer. `facingMode: 'environment'` is the rear lens. */
  facingMode?: 'environment' | 'user';
  title?: string;
  description?: string;
}

export function BarcodeScanner({
  open,
  onOpenChange,
  onDetected,
  facingMode = 'environment',
  title = 'Scan barcode',
  description = 'Point the camera at the barcode on the pack.',
}: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Wall-clock ms until which any further read is ignored. */
  const lockedUntilRef = useRef(0);
  /** Read inside the rAF loop, which must not re-subscribe on every render. */
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const [state, setState] = useState<ScanState>('starting');
  const [detail, setDetail] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const manualId = useId();

  const stopStream = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    // Tracks are stopped individually: on some browsers `stop()` on the stream
    // is not enough to release the camera.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const accept = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code) return;

      const now = Date.now();
      // A held-steady barcode is re-decoded on every poll. One lock covers both
      // that and a genuine double-tap, so a single barcode fires once.
      if (now < lockedUntilRef.current) return;

      lockedUntilRef.current = now + RESCAN_LOCK_MS;

      stopStream();
      onDetectedRef.current(code);
    },
    [stopStream],
  );

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    if (!open) {
      stopStream();
      return;
    }

    // Reset per-open state. Without this, a previous session's error is still
    // on screen when the dialog is reopened.
    lockedUntilRef.current = 0;
    setManual('');
    setDetail(null);

    const video = videoRef.current;
    const Detector = getDetectorConstructor();

    if (!Detector) {
      // Not a bug and not the user's fault — Safari and Firefox have no
      // BarcodeDetector. Manual entry below is the supported path.
      setState('unsupported');
      return;
    }

    // Re-bound to a non-null local: the closure below would otherwise keep
    // `Detector`'s nullable type.
    const DetectorClass = Detector;

    if (!window.isSecureContext) {
      setState('insecure');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      // Absent on insecure origins. Checked separately from `isSecureContext`
      // because localhost over http is a special case some browsers allow.
      setState('insecure');
      return;
    }

    let cancelled = false;

    async function start() {
      if (!video) return;

      let detector: BarcodeDetectorInstance;
      try {
        detector = new DetectorClass({ formats: FORMATS });
      } catch {
        // Older builds reject an explicit `formats` list. The default set is
        // narrower but still covers EAN/UPC.
        try {
          detector = new DetectorClass();
        } catch {
          setState('unsupported');
          return;
        }
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: false,
        });
      } catch (cause) {
        if (cancelled) return;
        setState(classifyCameraError(cause));
        setDetail(describeCameraError(cause));
        return;
      }

      if (cancelled) {
        // Unmounted while the permission prompt was up. Release immediately.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      try {
        await video.play();
      } catch {
        // Autoplay can be refused even muted; the stream still decodes.
      }

      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        return;
      }

      setState('scanning');

      let lastPoll = 0;

      const tick = async (timestamp: number) => {
        if (cancelled) return;
        frameRef.current = requestAnimationFrame(tick);

        // Decoding every frame burns battery for no gain — a barcode held
        // steady reads the same result. ~8Hz is well past what an attendant can
        // outrun and far cheaper.
        if (timestamp - lastPoll < IDLE_POLL_MS) return;
        lastPoll = timestamp;

        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

        try {
          const found = await detector.detect(video);
          const first = found[0]?.rawValue;
          if (first) accept(first);
        } catch {
          // A single failed detect() (frame torn down mid-decode) is not fatal.
          // The next tick retries.
        }
      };

      frameRef.current = requestAnimationFrame(tick);
    }

    void start();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open, facingMode, accept, stopStream]);

  /* ----------------------------------------------------------------- render */

  const submitManual = () => {
    const code = manual.trim();
    if (!code) return;
    stopStream();
    onDetected(code);
  };

  const scanning = state === 'scanning' || state === 'starting';
  const showCamera = scanning;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="size-4" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {showCamera ? (
            <div className="relative overflow-hidden rounded-lg border border-border bg-muted">
              <video
                ref={videoRef}
                muted
                playsInline
                aria-label="Camera preview"
                className={cn('aspect-video w-full object-cover', state === 'starting' && 'opacity-0')}
              />
              {state === 'starting' && (
                <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Starting camera…
                </p>
              )}
              {/* Framing guide. Purely decorative. */}
              {state === 'scanning' && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                  <div className="h-full w-full rounded-lg border-2 border-primary/70" />
                </div>
              )}
            </div>
          ) : (
            <CameraStateMessage state={state} detail={detail} />
          )}

          {/* Always offered. The camera is the fast path, never the only one. */}
          <Field>
            <FieldLabel htmlFor={manualId} className="text-muted-foreground">
              <Keyboard className="size-3.5" />
              Enter the code instead
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id={manualId}
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitManual();
                  }
                }}
                placeholder="8901030365012"
                inputMode="numeric"
                autoComplete="off"
                autoFocus={!showCamera}
              />
              <Button onClick={submitManual} disabled={manual.trim().length === 0}>
                Use
              </Button>
            </div>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ states */

function classifyCameraError(cause: unknown): ScanState {
  const name = cause instanceof DOMException ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'nocamera';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

function describeCameraError(cause: unknown): string | null {
  const name = cause instanceof DOMException ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow it in your browser settings, or type the code below.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera found on this device.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Another app is using the camera. Close it and try again.';
  }
  return 'The camera could not be started. Type the code below instead.';
}

const STATE_COPY: Record<
  Exclude<ScanState, 'scanning' | 'starting'>,
  { icon: typeof Camera; title: string; body: string }
> = {
  unsupported: {
    icon: CameraOff,
    title: 'Scanning not supported here',
    body: 'This browser has no built-in barcode reader. Enter the code manually — the numbers are printed under the barcode on the pack.',
  },
  insecure: {
    icon: TriangleAlert,
    title: 'Camera needs a secure connection',
    body: 'Browsers only allow camera access over HTTPS. Enter the code manually, or open the app over HTTPS to scan.',
  },
  denied: {
    icon: CameraOff,
    title: 'Camera permission denied',
    body: 'Grant camera access in your browser settings and scan again, or enter the code manually.',
  },
  nocamera: {
    icon: CameraOff,
    title: 'No camera on this device',
    body: 'Enter the code manually.',
  },
  busy: {
    icon: CameraOff,
    title: 'Camera is busy',
    body: 'Another app is using it. Close that app and scan again, or enter the code manually.',
  },
  failed: {
    icon: TriangleAlert,
    title: 'Camera unavailable',
    body: 'Enter the code manually.',
  },
};

function CameraStateMessage({ state, detail }: { state: ScanState; detail: string | null }) {
  if (state === 'scanning' || state === 'starting') return null;

  const copy = STATE_COPY[state];
  const Icon = copy.icon;

  return (
    <Alert variant={state === 'unsupported' || state === 'insecure' ? 'default' : 'destructive'}>
      <Icon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{detail ?? copy.body}</AlertDescription>
    </Alert>
  );
}
