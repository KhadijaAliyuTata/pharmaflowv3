/**
 * The invitation email, as text.
 *
 * Split out of `routes/api.send-invite.ts` for one reason: it is the only part of
 * that route that turns human input into markup, so it is the only part worth
 * testing directly. It lives here as plain functions with no Worker, Supabase or
 * router dependency, which means a test can exercise the escaping rules without
 * standing up a server or holding a session.
 *
 * Nothing else moved. The route imports these and is otherwise unchanged.
 */

/**
 * Escape a value for interpolation into HTML.
 *
 * Everything interpolated below came from a database row that a human typed, so
 * without this a name of `<img onerror=…>` would be live markup in an inbox.
 *
 * `&` is handled by the same single pass as the rest, which is what stops the
 * double-escaping that a naive `.replace('&', '&amp;').replace('<', '&lt;')` chain
 * produces on input that already contains an entity.
 */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * The two forms of the salutation.
 *
 * The HTML form is escaped so a name typed as markup cannot become markup. The
 * plain-text form is deliberately left raw, because escaping it would show a
 * text-only client `&amp;` instead of `&` — the entity is correct in HTML and
 * wrong everywhere else.
 *
 * Returns the HTML form only; the caller builds the text body, because that body
 * is composed alongside other plain-text lines and does not belong in here.
 */
export function greeting(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed ? `Hello ${escapeHtml(trimmed)},` : 'Hello,';
}

/** The same salutation, unescaped, for the `text/plain` alternative. */
export function greetingText(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed ? `Hello ${trimmed},` : 'Hello,';
}

export type EmailContent = {
  greeting: string;
  pharmacyName: string;
  roleLabel: string;
  code: string;
  joinUrl: string;
  expiresOn: string | null;
};

/**
 * Deliberately plain HTML.
 *
 * No CSS framework and no templating library: this is one transactional message
 * with one link, and a dependency to render it would be the only new thing in the
 * server bundle.
 *
 * Colours are literal hexes on purpose — email clients do not support CSS custom
 * properties, so the palette tokens are written out: navy-800 (#043263) for the
 * primary button, green-600 (#2a932c) for the link, amber-600 (#b45309) for the
 * expiry note. Keep them in step with `src/index.css`.
 */
export function emailHtml({
  greeting: greetingLine,
  pharmacyName,
  roleLabel,
  code,
  joinUrl,
  expiresOn,
}: EmailContent): string {
  const cell = 'padding:0 24px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1e293b;';
  const url = escapeHtml(joinUrl);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f8fa;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
      <tr><td style="${cell}padding-top:28px;">
        <p style="margin:0;font-size:13px;letter-spacing:.02em;color:#64748b;">PharmaFlow</p>
        <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3;">${greetingLine}</h1>
        <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#475569;">
          <strong>${escapeHtml(pharmacyName)}</strong> has added you to their team as a
          <strong>${escapeHtml(roleLabel)}</strong>. Choose your own password to accept —
          nobody else can see or set it.
        </p>
      </td></tr>

      <tr><td style="${cell}padding-top:22px;">
        <p style="margin:0 0 6px;font-size:12px;color:#64748b;">Your invitation code</p>
        <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;">${escapeHtml(code)}</p>
      </td></tr>

      <tr><td style="${cell}padding-top:22px;">
        <p style="margin:0;">
          <a href="${url}" style="display:inline-block;background:#043263;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Set my password &amp; join</a>
        </p>
        <p style="margin:12px 0 0;font-size:13px;color:#64748b;">Or open this link:</p>
        <p style="margin:4px 0 0;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#2a932c;">${url}</a></p>
        ${
          expiresOn
            ? `<p style="margin:12px 0 0;font-size:12px;color:#b45309;">This invitation expires on ${escapeHtml(expiresOn)}. After that your owner can send a new one.</p>`
            : ''
        }
      </td></tr>

      <tr><td style="${cell}padding-top:22px;padding-bottom:28px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
          This link only works for the address it was sent to, and only for this pharmacy.
          If you were not expecting this, ignore this email — nothing has been shared with
          you yet.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
}