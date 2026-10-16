/**
 * Request validation for `/api/accept-invite`.
 *
 * The endpoint is unauthenticated and holds the service-role key, so what it refuses
 * *before* touching the database is the security-relevant part. These assertions run
 * the real functions against real `Request` objects and real streams â€” nothing here is
 * a transcription of the code under test.
 *
 * The body-limit cases are deliberately hostile: a lying `Content-Length`, a chunked
 * body with no length at all, and a stream that crosses the limit partway through.
 *
 * Pure â€” no Worker, no database, no secret.
 */

import {
  MAX_BODY_BYTES,
  MAX_TOKEN_LENGTH,
  isJsonContentType,
  readJsonBody,
} from '../../src/lib/request-guard';
import { MIN_PASSWORD_LENGTH, parseAcceptBody } from '../../src/lib/accept-invite';

let pass = 0;
const failures: string[] = [];

const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' -> ' + detail : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
};

const section = (title: string) => console.log(`\n--- ${title} ---`);

/** A well-formed token: two UUIDs, dashes stripped, exactly 64 hex chars. */
const GOOD_TOKEN = 'a'.repeat(MAX_TOKEN_LENGTH);
const GOOD_PASSWORD = 'a'.repeat(MIN_PASSWORD_LENGTH);

/** Build a Request with a body, optionally overriding Content-Length. */
const jsonRequest = (
  body: string,
  init: { contentType?: string | null; contentLength?: string | null; omitLength?: boolean } = {},
): Request => {
  const headers = new Headers();
  const contentType = init.contentType === undefined ? 'application/json' : init.contentType;
  if (contentType !== null) headers.set('content-type', contentType);

  // `omitLength` leaves it absent, which is what a chunked request looks like.
  if (!init.omitLength && init.contentLength !== null) {
    headers.set('content-length', init.contentLength ?? String(new TextEncoder().encode(body).length));
  }

  return new Request('https://example.ng/api/accept-invite', {
    method: 'POST',
    headers,
    body,
    // Node/Bun requires this to stream rather than buffer, which is what we want to test.
    duplex: 'half',
  } as RequestInit);
};

// ---------------------------------------------------------------- content type

section('Content-Type must name JSON');

for (const [label, header, expected] of [
  ['application/json', 'application/json', true],
  ['with charset parameter', 'application/json; charset=utf-8', true],
  ['with other parameter', 'application/json;charset=UTF-8', true],
  ['uppercase', 'APPLICATION/JSON', true],
  ['mixed case with parameter', 'Application/Json; Charset=utf-8', true],
  ['surrounding whitespace', '  application/json  ', true],
  ['text/plain', 'text/plain', false],
  ['form encoding', 'application/x-www-form-urlencoded', false],
  ['multipart', 'multipart/form-data; boundary=x', false],
  ['text/json, a common wrong guess', 'text/json', false],
  ['json suffix subtype', 'application/vnd.api+json', false],
  ['absent', null, false],
  ['empty string', '', false],
] as [string, string | null, boolean][]) {
  check(`${label}: ${expected ? 'accepted' : 'refused'}`, isJsonContentType(header) === expected, header ?? '(none)');
}

// ---------------------------------------------------------------- body reading

section('a well-formed body is accepted and parsed');

{
  const body = JSON.stringify({ token: GOOD_TOKEN, password: GOOD_PASSWORD });
  const result = await readJsonBody(jsonRequest(body));
  check('a valid body is accepted', result.ok, '');
  check(
    '...and the fields survive the round trip',
    result.ok && (result.body as { token: string }).token === GOOD_TOKEN,
    result.ok ? 'token matches' : 'not ok',
  );
}

section('a body sent with a charset parameter is still read');

{
  const body = JSON.stringify({ token: GOOD_TOKEN, password: GOOD_PASSWORD });
  const result = await readJsonBody(jsonRequest(body, { contentType: 'application/json; charset=utf-8' }));
  check('it is accepted', result.ok, '');
}

section('malformed bodies are refused with 400');

for (const [label, body] of [
  ['truncated object', '{"token":"abc"'],
  ['trailing comma', '{"token":"abc",}'],
  ['single quotes', "{'token':'abc'}"],
  ['bare word', 'not json at all'],
  ['an empty body', ''],
  ['whitespace only', '   \n  '],
] as [string, string][]) {
  const result = await readJsonBody(jsonRequest(body, { omitLength: true }));
  check(`${label} is refused`, !result.ok, result.ok ? 'accepted it' : '');
  check(
    `  ...with 400`,
    !result.ok && result.status === 400,
    result.ok ? '' : `got ${result.status}`,
  );
}

{
  // A bare number is *valid JSON*, so the body reader is right to accept it and the
  // shape check downstream is right to refuse it. Asserting the real layer matters:
  // a test that expects 400 here would be testing a stricter reader than the one that
  // ships, and would pass only by accident.
  const numeric = await readJsonBody(jsonRequest('12345', { omitLength: true }));
  check('a bare number is readable, because it is valid JSON', numeric.ok, numeric.ok ? '' : `got ${numeric.status}`);

  const shaped = numeric.ok ? parseAcceptBody(numeric.body) : null;
  check('...but it is refused by the shape check', shaped?.ok === false, shaped?.ok === true ? 'accepted it' : '');
  check('...with a message', !!shaped && !shaped.ok && shaped.error.length > 0, shaped && !shaped.ok ? shaped.error : '');
}

// ---------------------------------------------------------------- body size

section('an oversized body is refused');

{
  const huge = `{"token":"${'a'.repeat(64)}","pad":"${'x'.repeat(MAX_BODY_BYTES * 2)}"}`;

  // With an honest declared length: refused before the body is read at all.
  const declared = await readJsonBody(jsonRequest(huge));
  check('with a declared oversized length it is refused', !declared.ok, declared.ok ? 'accepted' : '');
  check('  ...with 413', !declared.ok && declared.status === 413, declared.ok ? '' : `got ${declared.status}`);

  // A lying header that UNDERSTATES the size must not get through.
  const lying = await readJsonBody(jsonRequest(huge, { contentLength: '10' }));
  check(
    'with a content length that lies about being small it is still refused',
    !lying.ok,
    lying.ok ? 'accepted on the strength of the header' : '',
  );
  check('  ...with 413', !lying.ok && lying.status === 413, lying.ok ? '' : `got ${lying.status}`);

  // No declared length at all, i.e. a chunked request.
  const undeclared = await readJsonBody(jsonRequest(huge, { omitLength: true }));
  check('with no declared length at all it is still refused', !undeclared.ok, undeclared.ok ? 'accepted' : '');
  check('  ...with 413', !undeclared.ok && undeclared.status === 413, undeclared.ok ? '' : `got ${undeclared.status}`);
}

section('the size boundary is exact');

{
  const padding = (total: number) => {
    const head = '{"token":"a","pad":"';
    const tail = '"}';
    return head + 'x'.repeat(Math.max(0, total - head.length - tail.length)) + tail;
  };

  const atLimit = await readJsonBody(jsonRequest(padding(MAX_BODY_BYTES), { omitLength: true }));
  check(`a body of exactly ${MAX_BODY_BYTES} bytes is accepted`, atLimit.ok, atLimit.ok ? '' : `got ${atLimit.status}`);

  const overLimit = await readJsonBody(jsonRequest(padding(MAX_BODY_BYTES + 1), { omitLength: true }));
  check(`a body of ${MAX_BODY_BYTES + 1} bytes is refused`, !overLimit.ok, overLimit.ok ? 'accepted' : '');
  check('  ...with 413', !overLimit.ok && overLimit.status === 413, overLimit.ok ? '' : `got ${overLimit.status}`);
}

section('a hostile Content-Length cannot force a huge allocation');

{
  // A header claiming an absurd size must be refused on its face, never allocated.
  const absurd = await readJsonBody(
    jsonRequest(JSON.stringify({ token: GOOD_TOKEN, password: GOOD_PASSWORD }), {
      contentLength: String(Number.MAX_SAFE_INTEGER),
    }),
  );
  check('a huge declared length is refused immediately', !absurd.ok, absurd.ok ? 'accepted' : '');
  check('  ...with 413', !absurd.ok && absurd.status === 413, absurd.ok ? '' : `got ${absurd.status}`);

  // A negative or non-numeric header must not disable the streaming check.
  const nonsense = await readJsonBody(
    jsonRequest(`{"token":"${'a'.repeat(64)}","pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`, {
      contentLength: 'not-a-number',
    }),
  );
  check('a non-numeric content length falls through to streaming', !nonsense.ok, nonsense.ok ? 'accepted' : '');
  check('  ...and is refused as oversized', !nonsense.ok && nonsense.status === 413, nonsense.ok ? '' : `got ${nonsense.status}`);
}

section('a parse failure does not quote the body');

{
  // Deliberately malformed, and carrying a recognisable secret, so the assertion is
  // that the message says nothing about what was sent.
  const result = await readJsonBody(jsonRequest('{"token": "my-secret-value-999', { omitLength: true }));
  check('a parse failure returns 400', !result.ok && result.status === 400, result.ok ? '' : '');
  check(
    '  ...and the message does not echo what was sent',
    !result.ok && !result.error.includes('my-secret-value-999'),
    result.ok ? '' : result.error,
  );
  check(
    '  ...and carries no parser detail or stack',
    !result.ok && !/SyntaxError|position \d|Unexpected token|at Object/i.test(result.error),
    result.ok ? '' : result.error,
  );
  check(
    '  ...and is a fixed sentence, identical for every parse failure',
    result.ok === false && result.error === 'That request was not valid JSON.',
    result.ok ? '' : result.error,
  );
}

// ---------------------------------------------------------------- token

section('token shape is validated before anything else');

{
  check(`the limit matches the real token length (${MAX_TOKEN_LENGTH})`, MAX_TOKEN_LENGTH === 64, `${MAX_TOKEN_LENGTH} chars`);

  const valid = parseAcceptBody({ token: GOOD_TOKEN, password: GOOD_PASSWORD });
  check('a 64-character token is accepted', valid.ok, '');

  for (const [label, token] of [
    ['non-string', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an object', { hex: 'a' }],
    ['an array', ['a']],
    ['empty string', ''],
    ['whitespace only', '    '],
  ] as [string, unknown][]) {
    const r = parseAcceptBody({ token, password: GOOD_PASSWORD });
    check(`${label} is refused`, !r.ok, r.ok ? 'accepted it' : '');
    check(`  ...with a message`, !r.ok && r.error.length > 0, r.ok ? '' : r.error);
  }

  const tooLong = parseAcceptBody({ token: 'a'.repeat(MAX_TOKEN_LENGTH + 1), password: GOOD_PASSWORD });
  check('a token one character too long is refused', !tooLong.ok, tooLong.ok ? 'accepted it' : '');
  check('  ...saying so', !tooLong.ok && /length/i.test(tooLong.error), tooLong.ok ? '' : tooLong.error);

  const absurd = parseAcceptBody({ token: 'a'.repeat(100_000), password: GOOD_PASSWORD });
  check('an absurdly long token is refused', !absurd.ok, absurd.ok ? 'accepted it' : '');
  check('  ...with the same length message', !absurd.ok && /length/i.test(absurd.error), absurd.ok ? '' : absurd.error);

  // Surrounding whitespace is a paste artefact, not an attack, and is trimmed.
  const padded = parseAcceptBody({ token: `  ${GOOD_TOKEN}  `, password: GOOD_PASSWORD });
  check('a padded token is accepted and trimmed', padded.ok && padded.token === GOOD_TOKEN, padded.ok ? padded.token : '');
}

section('password validation is unchanged');

{
  const good = parseAcceptBody({ token: GOOD_TOKEN, password: GOOD_PASSWORD });
  check('a valid password still passes', good.ok, '');

  for (const [label, password] of [
    ['empty', ''],
    ['missing', undefined],
    ['non-string', 12345],
    ['null', null],
  ] as [string, unknown][]) {
    const r = parseAcceptBody({ token: GOOD_TOKEN, password });
    check(`${label} password is refused`, !r.ok, r.ok ? 'accepted it' : '');
  }

  // Token length is checked before the password, so an over-long token wins.
  const both = parseAcceptBody({ token: 'a'.repeat(200), password: '' });
  check('an over-long token is refused on token before password', !both.ok && /length/i.test(both.error), both.ok ? '' : both.error);
}

section('a body that passes every guard still reaches the normal flow');

{
  // The endpoint's own sequence, replayed: guard, then parse, then claim. Nothing
  // here asserts against a database; it confirms the guards admit a legitimate
  // request rather than refusing it for the wrong reason.
  const body = JSON.stringify({ token: GOOD_TOKEN, password: GOOD_PASSWORD });
  const contentTypeOk = isJsonContentType(jsonRequest(body).headers.get('content-type'));
  const read = await readJsonBody(jsonRequest(body));
  const parsed = read.ok ? parseAcceptBody(read.body) : null;

  check('content type accepted', contentTypeOk, '');
  check('body read', read.ok, '');
  check('parsed', parsed?.ok === true, parsed?.ok === true ? '' : (parsed as { error: string } | null)?.error);
  check('token survives unchanged', parsed?.ok && parsed.token === GOOD_TOKEN, '');
  check('password survives unchanged', parsed?.ok && parsed.password === GOOD_PASSWORD, '');
}

// ---------------------------------------------------------------- report

console.log(`\nverify-request-guard: ${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(`  failing: ${failures.join(' | ')}`);
process.exit(failures.length === 0 ? 0 : 1);
