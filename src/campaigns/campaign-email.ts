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
  /** How it looks; null is the PIC layout (navy header, no pictures). */
  design?: CampaignDesign | null;
}

/**
 * The look of a campaign email, set per campaign (a new one starts from the
 * event's branding). Pictures are storage keys; the email links them through
 * the API, which signs a fresh read each time a mail app fetches one.
 */
export interface CampaignDesign {
  /** Shown at the top of the header. */
  logo: string | null;
  /** A full-width picture under the header, such as the event flyer. */
  banner: string | null;
  /** #rrggbb */
  headerColor: string;
  /** #rrggbb */
  buttonColor: string;
  /** The small line above the event name; empty hides it. */
  eyebrow: string;
  showEventName: boolean;
  /** A line above the legal footer (contacts, sponsors); empty for none. */
  footer: string;
}

export const PIC_NAVY = '#002d74';

export const DEFAULT_DESIGN: CampaignDesign = {
  logo: null,
  banner: null,
  headerColor: PIC_NAVY,
  buttonColor: PIC_NAVY,
  eyebrow: 'Policy Innovation Centre',
  showEventName: true,
  footer: '',
};

/** Where the design's pictures load from in this email; null leaves that picture out. */
export interface CampaignImages {
  logo: string | null;
  banner: string | null;
}

const NO_IMAGES: CampaignImages = { logo: null, banner: null };

/** Light text on a dark colour, dark text on a light one (WCAG relative luminance). */
export function readsLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l =
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255);
  // white wins when it contrasts better than near-black
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05;
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
  images: CampaignImages = NO_IMAGES,
): RenderedEmail {
  const d = c.design ?? DEFAULT_DESIGN;
  const subject = merge(c.subject, r, event).replace(/\s+/g, ' ').trim();
  const body = merge(c.body, r, event);
  const label = c.buttonLabel ? merge(c.buttonLabel, r, event) : null;
  const url = c.buttonUrl;
  const why = `You are receiving this because you have a ticket to ${event}.`;

  const text = [
    body.trim(),
    label && url ? `${label}: ${url}` : null,
    d.footer.trim() || null,
    `--\n${why}\nPolicy Innovation Centre${unsubscribeUrl ? `\nUnsubscribe from event emails: ${unsubscribeUrl}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const button =
    label && url
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px"><tr><td style="background:${d.buttonColor};border-radius:8px"><a href="${escapeHtml(track ? track.link(url) : url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:${readsLight(d.buttonColor) ? '#ffffff' : '#111111'};text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`
      : '';

  const light = readsLight(d.headerColor);
  const eyebrow = d.eyebrow.trim();
  const header = [
    images.logo
      ? `<img src="${escapeHtml(images.logo)}" alt="" height="44" style="display:block;height:44px;max-width:220px;border:0${eyebrow || d.showEventName ? ';margin:0 0 12px' : ''}">`
      : '',
    eyebrow
      ? `<p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${light ? '#f2b705' : '#5c5c5c'}">${escapeHtml(eyebrow)}</p>`
      : '',
    d.showEventName
      ? `<p style="margin:${eyebrow ? '4px' : '0'} 0 0;font-size:20px;font-weight:600;color:${light ? '#ffffff' : '#111111'}">${escapeHtml(event)}</p>`
      : '',
  ].join('');
  const headerRow = header
    ? `<tr><td style="background:${d.headerColor};padding:20px 28px">${header}</td></tr>`
    : '';
  const bannerRow = images.banner
    ? `<tr><td style="padding:0;line-height:0"><img src="${escapeHtml(images.banner)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>`
    : '';
  const footer = d.footer.trim()
    ? `${escapeHtml(d.footer.trim()).replace(/\n/g, '<br>')}<br><br>`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
${headerRow}${bannerRow}<tr><td style="padding:28px 28px 12px">${bodyHtml(body, track)}${button}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #ececec"><p style="margin:0;font-size:12px;line-height:18px;color:#7c7c7c">${footer}${escapeHtml(why)}<br>Policy Innovation Centre${unsubscribeUrl ? ` · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7c7c7c;text-decoration:underline">Unsubscribe from event emails</a>` : ''}</p></td></tr>
</table></td></tr></table>${track ? `<img src="${escapeHtml(track.pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}</body></html>`;

  return { subject, text, html };
}
