/**
 * The invitation email's escaping.
 *
 * This suite exists because the email body is the one place in the invitation flow
 * that turns human input into markup. Everything else is enforced by the database,
 * which is covered by verify-staff-invitations.mjs. Here the enforcement is a
 * plain function, and a plain function can be asserted directly.
 *
 * The specific bug this pins: the salutation was computed once, HTML-escaped, and
 * then reused verbatim in the `text/plain` alternative. That is correct in the HTML
 * body and wrong in the text one, where a name containing `&` arrived as `&amp;`.
 * A shared string cannot be right in both, so there are two, and the tests below
 * assert they differ in exactly the way that fixes it.
 *
 * Runs against the module directly — no database, no Worker, no session.
 */

import { emailHtml, escapeHtml, greeting, greetingText } from '../../src/lib/invite-email';

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

/** The text a recipient actually reads: tags out, entities decoded. */
const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const NAME_WITH_EVERYTHING = `Ben & <Jerry> "Ice" O'Brien`;
const QUOTE = String.fromCharCode(39);

// ---------------------------------------------------------------- escaping

section('every character that could break out of HTML text is escaped');

for (const [label, input] of [
  ['ampersand', 'Ben & Jerry'],
  ['less-than', 'A <script>alert(1)</script>'],
  ['greater-than', 'x > y'],
  ['double quote', 'Ana "The Closer" Ruiz'],
  ['apostrophe', "O'Brien"],
  ['all five at once', NAME_WITH_EVERYTHING],
] as [string, string][]) {
  const out = escapeHtml(input);
  check(`${label}: emits no raw <`, !out.includes('<'), JSON.stringify(out));
  check(`${label}: emits no raw >`, !out.includes('>'), JSON.stringify(out));
  check(
    `${label}: every & became a real entity`,
    !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(out),
    JSON.stringify(out),
  );
}

check(
  'an existing entity is escaped once, not twice',
  escapeHtml('A &amp; B') === 'A &amp;amp; B',
  escapeHtml('A &amp; B'),
);

check(
  'escaping is reversible for round-tripping purposes',
  escapeHtml('plain name') === 'plain name',
  escapeHtml('plain name'),
);

// ---------------------------------------------------------------- greeting

section('the HTML salutation escapes, the plain-text one does not');

check(
  'HTML form escapes markup in the name',
  greeting('<img src=x onerror=alert(1)>') ===
    'Hello &lt;img src=x onerror=alert(1)&gt;,',
  greeting('<img src=x onerror=alert(1)>'),
);

check(
  'text form leaves the name alone',
  greetingText('<img src=x onerror=alert(1)>') === 'Hello <img src=x onerror=alert(1)>,',
  greetingText('<img src=x onerror=alert(1)>'),
);

check(
  'text form shows a real ampersand, not an entity',
  greetingText(NAME_WITH_EVERYTHING) === `Hello ${NAME_WITH_EVERYTHING},`,
  greetingText(NAME_WITH_EVERYTHING),
);

check(
  'text form contains no HTML entity at all',
  !/&amp;|&lt;|&gt;|&quot;|#39;/.test(greetingText(NAME_WITH_EVERYTHING)),
  greetingText(NAME_WITH_EVERYTHING),
);

check(
  'HTML form contains no raw angle bracket',
  !/[<>]/.test(greeting(NAME_WITH_EVERYTHING)),
  greeting(NAME_WITH_EVERYTHING),
);

check(
  'the two forms genuinely differ when the name needs escaping',
  greeting(NAME_WITH_EVERYTHING) !== greetingText(NAME_WITH_EVERYTHING),
);

check(
  "an apostrophe survives into the text body",
  greetingText(`O${QUOTE}Brien`) === `Hello O${QUOTE}Brien,`,
  greetingText(`O${QUOTE}Brien`),
);

section('a name that was not supplied produces a neutral greeting');

for (const [label, value] of [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
] as [string, string | null | undefined][]) {
  check(`HTML form for ${label} is "Hello,"`, greeting(value) === 'Hello,', greeting(value));
  check(`text form for ${label} is "Hello,"`, greetingText(value) === 'Hello,', greetingText(value));
}

check(
  'a name with surrounding whitespace is trimmed',
  greeting('  Aisha Yusuf  ') === 'Hello Aisha Yusuf,',
  greeting('  Aisha Yusuf  '),
);

// ---------------------------------------------------------------- the document

section('a name carrying markup cannot become markup in the rendered email');

const hostile = emailHtml({
  greeting: greeting('<img src=x onerror=alert(1)>'),
  pharmacyName: 'Ada Pharmacy',
  roleLabel: 'Assistant',
  code: 'a'.repeat(64),
  joinUrl: 'https://example.ng/join?token=abc123',
  expiresOn: 'Sat, 17 Oct 2026 00:00:00 GMT',
});

check('no live <img tag', !hostile.includes('<img'), '');
check('the escaped form is present instead', hostile.includes('&lt;img'), '');
check('the document still has exactly one <h1>', (hostile.match(/<h1/g) ?? []).length === 1);
check('the table still has its four rows', (hostile.match(/<tr>/g) ?? []).length === 4);
check('the document is still well-formed at the end', hostile.trimEnd().endsWith('</html>'));

section('the parts the invitee needs are all present');

const normal = emailHtml({
  greeting: greeting('Aisha Yusuf'),
  pharmacyName: 'Ada Pharmacy',
  roleLabel: 'Pharmacist',
  code: 'f'.repeat(64),
  joinUrl: 'https://example.ng/join?token=deadbeef',
  expiresOn: 'Sat, 17 Oct 2026 00:00:00 GMT',
});

check('brands the sender', normal.includes('PharmaFlow'), '');
check('names the pharmacy', normal.includes('Ada Pharmacy'), '');
check('names the role', normal.includes('Pharmacist'), '');
check('carries the code', normal.includes('f'.repeat(64)), '');
check('links to /join with the token', normal.includes('/join?token=deadbeef'), '');
check('states the expiry', normal.includes('Sat, 17 Oct 2026'), '');

// Scanned against the text the recipient reads, not the markup. Matching the raw
// document would trip over CSS `margin` in every inline style, which is noise and
// would make this assertion useless the moment someone restyles the email.
check(
  'the visible text mentions no cost, profit or margin figure',
  !/cost|profit|margin|cogs/i.test(stripTags(normal)),
  stripTags(normal).slice(0, 80),
);

section('a pharmacy name carrying markup is escaped too');

const hostilePharmacy = emailHtml({
  greeting: greeting('Aisha'),
  pharmacyName: '<b>Acme</b> & Co',
  roleLabel: 'Assistant',
  code: 'c'.repeat(64),
  joinUrl: 'https://example.ng/join?token=abc',
  expiresOn: null,
});

check(
  'no live <b> from the pharmacy name',
  !hostilePharmacy.includes('<b>Acme</b>'),
  '',
);
check('escaped pharmacy name present', hostilePharmacy.includes('&lt;b&gt;Acme'), '');
check('no expiry line when there is no expiry', !hostilePharmacy.includes('expires on'), '');

// ---------------------------------------------------------------- report

console.log(`\nverify-invite-email: ${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(`  failing: ${failures.join(' | ')}`);
process.exit(failures.length === 0 ? 0 : 1);