/**
 * What a campaign email says to one person: the organisers' text with their
 * details merged in, as plain text and in the branded layout. Pure, so the
 * console's preview and the sender can never disagree about a merge.
 */

/** Details that can be merged into the subject, the message and the button. */
export const MERGE_FIELDS = [
  'first_name',
  'name',
  'ticket_code',
  'tier',
  'event',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export interface CampaignRecipient {
  email: string;
  name: string;
  code: string;
  tier: string;
}

export interface CampaignContent {
  subject: string;
  body: string;
  buttonLabel: string | null;
  buttonUrl: string | null;
}

const FIELD = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Merge fields a text uses that do not exist, so a typo is caught before anyone is emailed. */
export function unknownFields(...texts: (string | null)[]): string[] {
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const [, field] of (text ?? '').matchAll(FIELD)) {
      if (!(MERGE_FIELDS as readonly string[]).includes(field.toLowerCase()))
        unknown.add(field);
    }
  }
  return [...unknown];
}

function values(
  r: CampaignRecipient,
  event: string,
): Record<MergeField, string> {
  return {
    first_name: r.name.trim().split(/\s+/)[0] ?? '',
    name: r.name.trim(),
    ticket_code: r.code,
    tier: r.tier,
    event,
  };
}

export function merge(
  text: string,
  r: CampaignRecipient,
  event: string,
  encode: (s: string) => string = (s) => s,
): string {
  const v = values(r, event);
  return text.replace(FIELD, (whole, field: string) => {
    const key = field.toLowerCase() as MergeField;
    return key in v ? encode(v[key]) : whole;
  });
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );

/** Tracking for one person's email: the open image, and each link through the click redirect. */
export interface EmailTracking {
  pixel: string;
  link: (url: string) => string;
}

const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Paragraphs on blank lines, line breaks kept, web addresses made links;
 * everything escaped first. With tracking, a link goes through the click
 * redirect while showing the address the organisers wrote.
 */
function bodyHtml(text: string, track: EmailTracking | null): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      const inner = escapeHtml(para)
        .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (shown) => {
          const href = track
            ? escapeHtml(track.link(unescapeHtml(shown)))
            : shown;
          return `<a href="${href}" style="color:#002d74;text-decoration:underline">${shown}</a>`;
        })
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#292929">${inner}</p>`;
    })
    .join('');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The email for one person. The layout is tables and inline styles, which
 * is what Outlook and Gmail both render; the plain-text part carries the
 * same words for mail apps that show no HTML.
 */
export function renderCampaign(
  c: CampaignContent,
  r: CampaignRecipient,
  event: string,
  unsubscribeUrl: string | null = null,
  track: EmailTracking | null = null,
): RenderedEmail {
  const subject = merge(c.subject, r, event).replace(/\s+/g, ' ').trim();
  const body = merge(c.body, r, event);
  const label = c.buttonLabel ? merge(c.buttonLabel, r, event) : null;
  const url = c.buttonUrl;
  const why = `You are receiving this because you have a ticket to ${event}.`;

  const text = [
    body.trim(),
    label && url ? `${label}: ${url}` : null,
    `--\n${why}\nPolicy Innovation Centre${unsubscribeUrl ? `\nUnsubscribe from event emails: ${unsubscribeUrl}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const button =
    label && url
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px"><tr><td style="background:#002d74;border-radius:8px"><a href="${escapeHtml(track ? track.link(url) : url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`
      : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#002d74;padding:20px 28px"><p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#f2b705">Policy Innovation Centre</p><p style="margin:4px 0 0;font-size:20px;font-weight:600;color:#ffffff">${escapeHtml(event)}</p></td></tr>
<tr><td style="padding:28px 28px 12px">${bodyHtml(body, track)}${button}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #ececec"><p style="margin:0;font-size:12px;line-height:18px;color:#7c7c7c">${escapeHtml(why)}<br>Policy Innovation Centre${unsubscribeUrl ? ` · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7c7c7c;text-decoration:underline">Unsubscribe from event emails</a>` : ''}</p></td></tr>
</table></td></tr></table>${track ? `<img src="${escapeHtml(track.pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}</body></html>`;

  return { subject, text, html };
}
