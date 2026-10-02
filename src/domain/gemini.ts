/**
 * Shared contract between the `/api/gemini` Worker route and the browser.
 *
 * Types only — no Zod, no `cloudflare:*` imports. This module is pulled into
 * the client bundle by `~/lib/gemini`, so anything Node-, Worker- or
 * Zod-specific here would ship to the browser or break the client build.
 *
 * The response schemas themselves live in the server route, because they exist
 * to defend the server against a hallucinating model, not the client against a
 * typed server.
 */

export type GeminiMode = 'prescription' | 'nafdac' | 'chat';

/**
 * Stable, machine-readable failure reasons.
 *
 * The UI branches on these rather than on message text. `no_api_key` is
 * deliberately distinct: it means "this deployment has no AI configured", which
 * is a setup problem the operator must fix, not a transient failure the
 * attendant should retry.
 */
export type GeminiErrorCode =
  /** `GEMINI_API_KEY` is not set on this Worker. */
  | 'no_api_key'
  /** Body was not JSON, or failed the request schema. */
  | 'bad_request'
  /** Model did not answer within the budget. */
  | 'timeout'
  /** Gemini returned non-2xx, or no usable candidate. */
  | 'model_error'
  /** Model answered, but the answer did not match its schema. */
  | 'bad_model_output'
  | 'unknown';

/** The only error shape this API ever returns. */
export interface GeminiError {
  error: string;
  code: GeminiErrorCode;
}

/** Thrown-style failures as a value, so no call site needs a try/catch. */
export type GeminiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: GeminiError };

/* ------------------------------------------------------------- prescription */

export type ReadConfidence = 'high' | 'medium' | 'low';

/** One line item read off a prescription image. */
export interface PrescriptionMedication {
  /** As written on the script, e.g. "Amoxicillin". */
  name: string;
  /** e.g. "500mg". Empty when the script did not state one. */
  strength: string;
  /** e.g. "Capsule". Empty when unclear. */
  dosageForm: string;
  /** Units as written. `null` when the script gave no number. */
  quantity: number | null;
  /** e.g. "1 capsule three times daily". Empty when not stated. */
  directions: string;
  /**
   * How sure the reader is that this line was actually legible. Anything
   * below `medium` is a guess and is surfaced as such in the review list.
   */
  confidence: ReadConfidence;
}

export interface PrescriptionResult {
  medications: PrescriptionMedication[];
  patientName: string | null;
  prescriber: string | null;
  /** ISO date if one could be read. */
  date: string | null;
  notes: string | null;
  /**
   * False when the image was too blurred, cropped or dark to read reliably.
   * The UI must not present a low-confidence extraction as a clean read.
   */
  legible: boolean;
}

/* ------------------------------------------------------------------ nafdac */

export interface NafdacResult {
  registrationNumber: string;
  /**
   * `null` when the model could not tell. Deliberately not a boolean default:
   * "not registered" and "could not check" are very different claims.
   */
  registered: boolean | null;
  productName: string | null;
  manufacturer: string | null;
  status: string | null;
  warnings: string[];
  /**
   * Gemini has no live NAFDAC database. This is always the model's own
   * training knowledge, so the UI must label it as unverified and must never
   * present a `registered: true` as a clearance.
   */
  source: 'model-knowledge' | 'unavailable';
  caveat: string | null;
}

/* -------------------------------------------------------------------- chat */

/** Short, factual answer about the pharmacy's own data. */
export interface ChatResult {
  answer: string;
  /** Items the model grounded its answer in, for display. */
  citations: string[];
}

/* ---------------------------------------------------------------- requests */

export interface PrescriptionRequest {
  mode: 'prescription';
  /** `data:<mime>;base64,<payload>`. */
  image: string;
  /** Anything the attendant already knows, e.g. the patient's complaint. */
  hint?: string;
}

export interface NafdacRequest {
  mode: 'nafdac';
  registrationNumber: string;
}

export interface ChatRequest {
  mode: 'chat';
  message: string;
  /**
   * A small, pre-aggregated snapshot of the pharmacy. Sent as text rather than
   * the raw store so the model never sees customer records.
   */
  context?: string;
}

export type GeminiRequest =
  | PrescriptionRequest
  | NafdacRequest
  | ChatRequest;

/**
 * Success body from `/api/gemini`. Discriminated on `mode` so the browser
 * narrows exactly the way the Worker did, instead of re-asserting which shape
 * it expects on a value that came off the network.
 */
export type GeminiResponse =
  | { mode: 'prescription'; data: PrescriptionResult }
  | { mode: 'nafdac'; data: NafdacResult }
  | { mode: 'chat'; data: ChatResult };

/* ----------------------------------------------------------------- helpers */

/** The one key every call path can fall back to. */
export const GEMINI_UNAVAILABLE_HINT =
  'Set GEMINI_API_KEY as a Worker secret (`wrangler secret put GEMINI_API_KEY`), or in .dev.vars for local dev.';

export function isNoApiKey(error: GeminiError): boolean {
  return error.code === 'no_api_key';
}
