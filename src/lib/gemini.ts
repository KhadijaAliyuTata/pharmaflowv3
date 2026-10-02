import type {
  ChatRequest,
  ChatResult,
  GeminiError,
  GeminiErrorCode,
  GeminiMode,
  GeminiRequest,
  GeminiResponse,
  GeminiResult,
  NafdacRequest,
  NafdacResult,
  PrescriptionRequest,
  PrescriptionResult,
} from '~/domain/gemini';

/**
 * Browser-side client for `/api/gemini`.
 *
 * Every function returns a `GeminiResult` and never throws. A missing API key
 * is a *normal, expected* state — most self-hosted deployments will not have
 * one — so it is a typed value the UI can render, not an exception. Callers are
 * forced by the type system to deal with it, which is the point: it is very
 * easy to ship an AI panel that silently shows nothing when the key is absent.
 *
 * The route already validated the model output against a Zod schema, so a
 * successful result is trusted. It is not re-validated here: duplicating the
 * schemas on the client would ship Zod to every visitor to re-check a contract
 * the server enforces at the only boundary that matters.
 */

const ENDPOINT = '/api/gemini';

/** Slightly longer than the server's 20s, so the server's own timeout wins. */
const CLIENT_TIMEOUT_MS = 25_000;

function networkError(message: string): GeminiError {
  return { error: message, code: 'unknown' };
}

function unexpected(cause: unknown): GeminiError {
  const message = cause instanceof Error ? cause.message : 'Unexpected failure';
  return { error: `Could not reach the AI service. ${message}`, code: 'unknown' };
}

/**
 * Narrow an untrusted parsed body to a `GeminiResponse`.
 *
 * The server's Zod pass makes this near-certain to succeed, but the value
 * crossed the network, so a shape check is still owed before it reaches
 * component state. Kept deliberately shallow — it only has to reject
 * structurally impossible bodies, not re-derive the model schema.
 */
function isGeminiResponse(value: unknown, mode: GeminiMode): value is GeminiResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as { mode?: unknown; data?: unknown };
  if (body.mode !== mode) return false;
  return typeof body.data === 'object' && body.data !== null;
}

async function post<T extends GeminiRequest>(
  body: T,
  expect: T['mode'],
): Promise<GeminiResult<GeminiResponseOf<T['mode']>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const failure = payload as Partial<GeminiError> | null;
      return {
        ok: false,
        error: {
          error:
            (failure && typeof failure.error === 'string' && failure.error) ||
            `Request failed with status ${response.status}.`,
          code: (failure && typeof failure.code === 'string' && failure.code) || 'unknown',
        },
      };
    }

    if (!isGeminiResponse(payload, expect)) {
      return {
        ok: false,
        error: { error: 'The AI service replied in an unexpected shape.', code: 'bad_model_output' },
      };
    }

    return { ok: true, data: payload.data as GeminiResponseOf<T['mode']> };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return { ok: false, error: { error: 'The AI service took too long to answer.', code: 'timeout' } };
    }
    return { ok: false, error: unexpected(cause) };
  } finally {
    clearTimeout(timer);
  }
}

type GeminiResponseOf<M extends GeminiMode> = M extends 'prescription'
  ? PrescriptionResult
  : M extends 'nafdac'
    ? NafdacResult
    : ChatResult;

/* ------------------------------------------------------------------ modes */

/** Read the medications off a prescription photo. */
export function readPrescription(
  input: Omit<PrescriptionRequest, 'mode'>,
): Promise<GeminiResult<PrescriptionResult>> {
  return post<PrescriptionRequest>({ mode: 'prescription', ...input }, 'prescription');
}

/** Check a NAFDAC registration number. Not a live database lookup. */
export function verifyNafdac(
  input: Omit<NafdacRequest, 'mode'>,
): Promise<GeminiResult<NafdacResult>> {
  return post<NafdacRequest>({ mode: 'nafdac', ...input }, 'nafdac');
}

/** Ask a question about the pharmacy's own data. */
export function askPharmacy(input: Omit<ChatRequest, 'mode'>): Promise<GeminiResult<ChatResult>> {
  return post<ChatRequest>({ mode: 'chat', ...input }, 'chat');
}

/* ------------------------------------------------------------- capability */

export interface AiStatus {
  configured: boolean;
  model?: string;
  setup?: string;
}

/**
 * Ask whether AI is configured, so a screen can hide or annotate the feature
 * *before* the attendant uses it, instead of failing after they have already
 * photographed a prescription.
 */
export async function getAiStatus(): Promise<AiStatus> {
  try {
    const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) return { configured: false };
    const payload = (await response.json()) as { ai?: AiStatus };
    return payload.ai ?? { configured: false };
  } catch (cause) {
    return { configured: false, setup: networkError(String(cause)).error };
  }
}

export type { GeminiError, GeminiErrorCode, GeminiResult };
