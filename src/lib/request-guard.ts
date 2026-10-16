/**
 * Request validation for the unauthenticated acceptance endpoint.
 *
 * Split out for the same reason `accept-invite.ts` and `invite-email.ts` are: this is
 * the part that decides whether a stranger's request is even worth looking at, and it
 * must be testable without a Worker, a Supabase connection, or a secret.
 *
 * ## Why this is separate at all
 *
 * `/api/accept-invite` is reachable by anyone and holds the service-role key. Before
 * this module existed, a caller could send any content type, any body size, and any
 * token length, and the request reached a privileged database round trip before
 * anything objected. The rejection now happens here, first, with no network call and
 * no allocation of a privileged client.
 *
 * ## The body limit does not trust Content-Length
 *
 * `Content-Length` is a hint from the client. It is absent on chunked requests and
 * trivially misstated by anything that is not a browser form. So it is used only as a
 * cheap early rejection — when it *does* declare something too large, the body is
 * refused without being read at all — and the authoritative limit is enforced while
 * streaming, which is what catches an absent or lying header.
 */

/**
 * Largest request body accepted, in bytes.
 *
 * Eight KiB is roughly two orders of magnitude more than the endpoint needs: a token
 * of 64 characters plus a password of at most 200 is well under 512 bytes. The
 * headroom absorbs JSON whitespace and any future field without leaving room for a
 * payload that exists only to consume memory or parse time.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * Largest invitation token accepted, in characters.
 *
 * Not a guess. `staff_invitations.token` defaults to
 * `replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')` — two UUIDs
 * with their dashes stripped, so exactly 64 hex characters, verified against live rows
 * (min and max both 64).
 *
 * Bounding at the real length means a token far longer than any legitimate one is
 * refused before it becomes a database lookup, rather than travelling to Postgres as a
 * parameter nothing will ever match.
 */
export const MAX_TOKEN_LENGTH = 64;

export type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 415 | 413 | 400; error: string };

/**
 * Whether a `Content-Type` header names JSON.
 *
 * Only the media type is considered; parameters such as `charset=utf-8` are ignored,
 * as they should be. Compared case-insensitively, and tolerant of surrounding
 * whitespace, because all three are things real clients vary on.
 *
 * `application/json` is required rather than a wildcard or an absent header: this
 * endpoint takes structured input, and a client that cannot say so is a client worth
 * refusing before it can reach a privileged call.
 */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;

  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json';
}

/**
 * Read and parse a JSON body within a hard size limit.
 *
 * Streams the body and stops as soon as the running total exceeds the limit, so an
 * oversized body is abandoned mid-flight rather than buffered whole. `reader.cancel()`
 * releases the connection instead of draining it.
 *
 * A declared `Content-Length` above the limit short-circuits before any read, which
 * makes the common honest-oversized case free. It is never trusted for acceptance:
 * a smaller or absent header falls through to the streaming check, which is what
 * actually decides.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: 'That request is too large.',
    };
  }

  const stream = request.body;
  if (!stream) {
    return { ok: false, status: 400, error: 'Send the invitation code and a password.' };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'That request is too large.' };
      }
      chunks.push(value);
    }
  } catch {
    // A body that fails mid-stream is a client-side problem, not a server fault.
    return { ok: false, status: 400, error: 'Could not read that request.' };
  }

  const raw = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder().decode(raw);
  } catch {
    return { ok: false, status: 400, error: 'That request could not be read.' };
  }

  if (text.trim() === '') {
    return { ok: false, status: 400, error: 'Send the invitation code and a password.' };
  }

  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    // The parse error itself is not echoed: it can quote the body back to the caller.
    return { ok: false, status: 400, error: 'That request was not valid JSON.' };
  }
}
