import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import type {
  ChatResult,
  GeminiError,
  GeminiErrorCode,
  GeminiRequest,
  GeminiResponse,
  NafdacResult,
  PrescriptionResult,
} from '~/domain/gemini';
import { GEMINI_UNAVAILABLE_HINT } from '~/domain/gemini';

/**
 * The single AI gateway for the app.
 *
 * Every model call in PharmaFlow goes through `mode` on this one route rather
 * than talking to Gemini from the browser. Two reasons:
 *   1. `GEMINI_API_KEY` is a Worker secret. A key shipped to the client is a
 *      key anyone can lift off a devtools network tab and bill.
 *   2. Model output is untrusted input. It is parsed and shape-checked here, so
 *      a hallucinated field can never reach a component as `string | null`
 *      pretending to be a `number`.
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** A hung model call must not hold a Worker request open indefinitely. */
const TIMEOUT_MS = 20_000;

/** Guard rail against a huge base64 payload wedging the request body. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const MAX_TEXT_CHARS = 8_000;

/* ------------------------------------------------------------------ errors */

function fail(status: number, code: GeminiErrorCode, error: string): Response {
  return Response.json({ error, code } satisfies GeminiError, { status });
}

/* ------------------------------------------------------------ secret access */

/**
 * `Cloudflare.Env` is generated from wrangler config and is currently empty,
 * so the secret has to be read off an untyped view of the bindings. Anything
 * other than a non-empty string counts as "not configured" — an empty
 * `GEMINI_API_KEY=""` in `.dev.vars` is the common case, and treating it as
 * present would produce a confusing 400 from Google instead of a clear 503.
 */
function readApiKey(): string {
  const bindings = env as unknown as Record<string, unknown>;
  const key = bindings.GEMINI_API_KEY;
  return typeof key === 'string' ? key.trim() : '';
}

/* --------------------------------------------------------- request schemas */

const requestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('prescription'),
    image: z.string().min(1).max(12_000_000),
    hint: z.string().max(MAX_TEXT_CHARS).optional(),
  }),
  z.object({
    mode: z.literal('nafdac'),
    registrationNumber: z.string().trim().min(3).max(64),
  }),
  z.object({
    mode: z.literal('chat'),
    message: z.string().trim().min(1).max(MAX_TEXT_CHARS),
    context: z.string().max(MAX_TEXT_CHARS).optional(),
  }),
]);

/* -------------------------------------------------------- response schemas */

/**
 * "Strict" here means: the fields the UI renders on are required and tightly
 * typed, and anything the model invents is dropped rather than passed through.
 * Unknown *keys* are stripped instead of rejected, because a model that adds
 * one extra key has still given a correct answer, and failing the whole
 * prescription over it would be worse than useless to an attendant standing at
 * the counter.
 */

const readConfidence = z.enum(['high', 'medium', 'low']);

/** "2 tabs", "2", "x2", "2x3 daily" → 2. Anything unparseable → null. */
const looseQuantity = z.preprocess((value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return null;
  const match = /(\d+(?:\.\d+)?)/.exec(value.replace(/[,\s]/g, ' '));
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}, z.number().int().min(0).nullable());

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  });

const prescriptionResponseSchema = z.object({
  legible: z.boolean().catch(false),
  patientName: nullableString,
  prescriber: nullableString,
  date: nullableString,
  notes: nullableString,
  medications: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'a medication line needs a name'),
        strength: z.string().trim().catch(''),
        dosageForm: z.string().trim().catch(''),
        quantity: looseQuantity,
        directions: z.string().trim().catch(''),
        confidence: readConfidence.catch('low'),
      }),
    )
    .max(40)
    .catch([]),
});

const nafdacResponseSchema = z.object({
  registered: z.boolean().nullable().catch(null),
  productName: nullableString,
  manufacturer: nullableString,
  status: nullableString,
  warnings: z.array(z.string().trim()).max(12).catch([]),
  source: z.enum(['model-knowledge', 'unavailable']).catch('unavailable'),
  caveat: nullableString,
});

const chatResponseSchema = z.object({
  answer: z.string().trim().min(1),
  citations: z.array(z.string().trim()).max(12).catch([]),
});

/** Normalises a `ReadConfidence` that came through `.catch()`. */

/* ------------------------------------------------------------- prompt wire */

/**
 * `responseSchema` + `responseMimeType` make Gemini emit schema-shaped JSON,
 * which is far more reliable than parsing prose. Zod still runs afterwards
 * because the structured-output guarantee is a strong hint, not a contract.
 */
function jsonConfig(properties: Record<string, unknown>, order: string[]) {
  return {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties, propertyOrdering: order },
  };
}

interface Built {
  systemInstruction: string;
  parts: { text?: string; inlineData?: { mimeType: string; data: string } }[];
  properties: Record<string, unknown>;
  order: string[];
  /**
   * Wraps the mode's Zod schema so the handler gets one narrowing-friendly
   * shape instead of `SafeParseReturnType`, whose generic parameter differs per
   * mode and collapses to `{}` once the three are unioned.
   */
  parse: (raw: unknown) => Parsed | undefined;
}

type Parsed = { ok: true; data: unknown } | { ok: false };

function guard(schema: {
  safeParse: (raw: unknown) => { success: true; data: unknown } | { success: false };
}): (raw: unknown) => Parsed | undefined {
  return (raw) => {
    const result = schema.safeParse(raw);
    return result.success ? { ok: true, data: result.data } : undefined;
  };
}

const SCRIPT_JSON: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Medication name exactly as written' },
    strength: { type: 'STRING' },
    dosageForm: { type: 'STRING' },
    quantity: { type: 'STRING', description: 'Quantity as written, e.g. "2 tablets"' },
    directions: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['name', 'strength', 'dosageForm', 'quantity', 'directions', 'confidence'],
  propertyOrdering: ['name', 'strength', 'dosageForm', 'quantity', 'directions', 'confidence'],
};

function buildPrescription(body: Extract<GeminiRequest, { mode: 'prescription' }>): Built | Response {
  const parsed = parseImageDataUrl(body.image);
  if (parsed instanceof Response) return parsed;

  const hint = body.hint?.trim();
  return {
    systemInstruction:
      'You transcribe handwritten and printed prescriptions for a pharmacy counter. ' +
      'Read only what is actually on the page. Never guess a drug, strength or dose that is not legible. ' +
      'If a field cannot be read, return an empty string for it, or null at the top level. ' +
      'Set legible=false if the image is too blurred, dark, cropped or low-resolution to read reliably.',
    parts: [
      {
        text:
          'List every medication on this prescription.' +
          (hint ? `\nThe patient told the attendant: "${hint}".` : '') +
          '\nIf you cannot identify the product, still list the text you can read and mark confidence low.',
      },
      { inlineData: parsed },
    ],
    properties: {
      legible: { type: 'BOOLEAN' },
      patientName: { type: 'STRING' },
      prescriber: { type: 'STRING' },
      date: { type: 'STRING' },
      notes: { type: 'STRING' },
      medications: { type: 'ARRAY', items: SCRIPT_JSON },
    },
    order: ['legible', 'patientName', 'prescriber', 'date', 'notes', 'medications'],
    parse: guard(prescriptionResponseSchema),
  };
}

function buildNafdac(body: Extract<GeminiRequest, { mode: 'nafdac' }>): Built | Response {
  return {
    systemInstruction:
      'You are helping a Nigerian pharmacist check a NAFDAC registration number. ' +
      'IMPORTANT: you have no live access to the NAFDAC database. You may only report what you recall ' +
      'from training data, and you must say so. Never state that a product is registered or approved ' +
      'unless you are genuinely confident, and never invent a registration number, approval date or ' +
      'manufacturer name. If you are unsure, set registered=null and source="unavailable". ' +
      'Always advise the pharmacist to confirm on the official NAFDAC portal before dispensing.',
    parts: [
      {
        text:
          `NAFDAC registration number: ${body.registrationNumber}\n\n` +
          'What do you know about this registration? Include any recall or safety warnings you recall.',
      },
    ],
    properties: {
      registered: { type: 'BOOLEAN' },
      productName: { type: 'STRING' },
      manufacturer: { type: 'STRING' },
      status: { type: 'STRING' },
      warnings: { type: 'ARRAY', items: { type: 'STRING' } },
      source: { type: 'STRING', enum: ['model-knowledge', 'unavailable'] },
      caveat: { type: 'STRING' },
    },
    order: ['registered', 'productName', 'manufacturer', 'status', 'warnings', 'source', 'caveat'],
    parse: guard(nafdacResponseSchema),
  };
}

function buildChat(body: Extract<GeminiRequest, { mode: 'chat' }>): Built | Response {
  return {
    systemInstruction:
      'You are the assistant inside a Nigerian pharmacy management app. ' +
      'Answer from the CONTEXT given, which is a summary of this pharmacy\'s own records. ' +
      'Be brief — two or three sentences. Never invent stock levels, prices or customers that are not in the context. ' +
      'If the context does not contain the answer, say so plainly. ' +
      'You give information only: never tell the user to change a price, approve a receipt or void a sale.',
    parts: [
      {
        text:
          (body.context?.trim()
            ? `CONTEXT:\n${body.context.trim()}\n\n`
            : 'CONTEXT: none available.\n\n') +
          `QUESTION: ${body.message.trim()}`,
      },
    ],
    properties: {
      answer: { type: 'STRING' },
      citations: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    order: ['answer', 'citations'],
    parse: guard(chatResponseSchema),
  };
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; data: string } | Response {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl.trim(),
  );
  if (!match?.[1] || !match[2]) {
    return fail(400, 'bad_request', 'image must be a base64 data URL (png, jpeg or webp).');
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const data = match[2];

  // base64 inflates by 4/3; compare against the decoded size.
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return fail(413, 'bad_request', 'image is too large. Use a photo under 4MB.');
  }

  return { mimeType, data };
}

/* ------------------------------------------------------- model invocation */

/** Models habitually wrap JSON in ```json fences even when told not to. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

interface GeminiReply {
  text: string;
  finishReason: string | null;
}

async function callGemini(apiKey: string, built: Built): Promise<GeminiReply | GeminiError> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: built.systemInstruction }] },
        contents: [{ role: 'user', parts: built.parts }],
        generationConfig: jsonConfig(built.properties, built.order),
      }),
    });

    if (!response.ok) {
      // The upstream body is deliberately not relayed. It echoes request
      // content, it is verbose, and the one thing an operator needs — which
      // status came back — is already in it.
      return {
        error: `Gemini rejected the request (HTTP ${response.status}). Check the API key and the model name.`,
        code: 'model_error',
      };
    }

    const payload = (await response.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
    };

    const candidate = payload.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      const reason = candidate?.finishReason ?? payload.promptFeedback?.blockReason ?? 'no content';
      return { error: `Gemini returned no usable content (${reason}).`, code: 'model_error' };
    }

    return { text, finishReason: candidate?.finishReason ?? null };
  } catch (cause) {
    if (timedOut) {
      return { error: `Gemini did not respond within ${TIMEOUT_MS / 1000}s.`, code: 'timeout' };
    }
    return {
      error: cause instanceof Error ? cause.message : 'Could not reach Gemini.',
      code: 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}

function isGeminiError(value: GeminiReply | GeminiError): value is GeminiError {
  return 'code' in value;
}

/* -------------------------------------------------------------------- route */

export const Route = createFileRoute('/api/gemini')({
  server: {
    handlers: {
      /**
       * `GET` is a liveness probe that also reports whether AI is configured,
       * so a screen can tell the difference between "broken" and "not set up"
       * before offering the feature at all. The key itself never leaves here.
       */
      GET: () => {
        const configured = readApiKey().length > 0;
        return Response.json({
          ok: true,
          ai: {
            configured,
            model: MODEL,
            ...(configured ? {} : { setup: GEMINI_UNAVAILABLE_HINT }),
          },
        });
      },

      POST: async ({ request }) => {
        const apiKey = readApiKey();

        // Checked before parsing the body. An unconfigured deployment cannot
        // serve any mode, so there is nothing a request could usefully do.
        if (!apiKey) {
          return fail(503, 'no_api_key', `Gemini is not configured. ${GEMINI_UNAVAILABLE_HINT}`);
        }

        let rawBody: unknown;
        try {
          rawBody = await request.json();
        } catch {
          return fail(400, 'bad_request', 'Request body must be JSON.');
        }

        const parsed = requestSchema.safeParse(rawBody);
        if (!parsed.success) {
          return fail(400, 'bad_request', describeIssues(parsed.error));
        }

        // No cast: the Zod union already discriminates on `mode`, so this
        // assignment is checked, not asserted.
        const body: GeminiRequest = parsed.data;

        let built: Built | Response;
        try {
          built =
            body.mode === 'prescription'
              ? buildPrescription(body)
              : body.mode === 'nafdac'
                ? buildNafdac(body)
                : buildChat(body);
        } catch {
          return fail(400, 'bad_request', 'Could not prepare that request.');
        }

        if (built instanceof Response) return built;

        const reply = await callGemini(apiKey, built);
        if (isGeminiError(reply)) {
          return fail(reply.code === 'timeout' ? 504 : 502, reply.code, reply.error);
        }

        let json: unknown;
        try {
          json = JSON.parse(stripFences(reply.text));
        } catch {
          return fail(
            502,
            'bad_model_output',
            `Gemini replied with something that is not JSON (${reply.finishReason ?? 'no reason given'}).`,
          );
        }

        const validated = built.parse(json);
        if (!validated?.ok) {
          // The raw model text is deliberately not returned — it can contain
          // prose, and echoing it would push unsanitised text into the UI.
          return fail(
            502,
            'bad_model_output',
            'Gemini replied in an unexpected shape. Try again, or enter the items manually.',
          );
        }

        // `mode` is echoed so the success body is self-describing: the client
        // narrows on the server's verdict rather than its own bookkeeping.
        return Response.json(reshape(body, validated.data));
      },
    },
  },
});

/**
 * Flatten the Zod output into the public contract in `~/domain/gemini`.
 *
 * Builds the whole `GeminiResponse` — mode and data together — rather than
 * just the data, so the compiler can check that the payload actually matches
 * the mode it is being labelled with. A `satisfies` on a bare object literal
 * would widen `mode` to the full union and lose that correlation.
 */
function reshape(body: GeminiRequest, data: unknown): GeminiResponse {
  if (body.mode === 'prescription') {
    const value = data as z.infer<typeof prescriptionResponseSchema>;
    return {
      mode: 'prescription',
      data: {
        legible: value.legible,
        patientName: value.patientName,
        prescriber: value.prescriber,
        date: value.date,
        notes: value.notes,
        medications: value.medications.map((medication) => ({
          ...medication,
          confidence: medication.confidence,
        })),
      } satisfies PrescriptionResult,
    };
  }

  if (body.mode === 'nafdac') {
    const value = data as z.infer<typeof nafdacResponseSchema>;
    return {
      mode: 'nafdac',
      data: {
        // Normalised to the same casing the caller sent, so the UI echoes one
        // canonical number rather than whatever the model typed back.
        registrationNumber: body.registrationNumber,
        registered: value.registered,
        productName: value.productName,
        manufacturer: value.manufacturer,
        status: value.status,
        warnings: value.warnings,
        source: value.source,
        caveat: value.caveat,
      } satisfies NafdacResult,
    };
  }

  return {
    mode: 'chat',
    data: data as z.infer<typeof chatResponseSchema> satisfies ChatResult,
  };
}

function describeIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Request body is invalid.';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}
