import {
  DEFAULT_DESIGN,
  merge,
  readsLight,
  renderCampaign,
  unknownFields,
  type CampaignRecipient,
} from './campaign-email';

/**
 * Campaign emails: each person's details merged in, everything the
 * organisers or a delegate typed escaped in the HTML, and a plain-text copy
 * that says the same.
 */
const ada: CampaignRecipient = {
  email: 'ada@example.com',
  name: '  Ada   Okafor ',
  code: 'PIC-VIP-AB12',
  tier: 'VIP',
};

describe('campaign emails', () => {
  it('merges details, ignoring case and spaces in the braces', () => {
    expect(
      merge(
        'Hi {{first_name}}, {{ NAME }}: {{ticket_code}} ({{tier}}) at {{event}}',
        ada,
        'GS-27',
      ),
    ).toBe('Hi Ada, Ada   Okafor: PIC-VIP-AB12 (VIP) at GS-27');
  });

  it('names merge fields that do not exist', () => {
    expect(
      unknownFields('Hi {{firstname}}', null, '{{event}} {{seat}}'),
    ).toEqual(['firstname', 'seat']);
    expect(unknownFields('Hi {{first_name}}')).toEqual([]);
  });

  it('escapes what people typed, keeps paragraphs and links addresses', () => {
    const mail = renderCampaign(
      {
        subject: 'Your {{tier}} badge',
        body: 'Hello {{first_name}},\n\nSee https://pic.org/gs27. <b>Bring ID</b>\nLine two',
        buttonLabel: 'Open the programme',
        buttonUrl: 'https://pic.org/programme?a=1&b=2',
      },
      { ...ada, name: 'Ada <script>' },
      'GS-27 & Friends',
    );
    expect(mail.subject).toBe('Your VIP badge');
    expect(mail.html).toContain('Hello Ada,</p>');
    expect(mail.html).toContain('&lt;b&gt;Bring ID&lt;/b&gt;<br>Line two');
    expect(mail.html).toContain('<a href="https://pic.org/gs27"');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('href="https://pic.org/programme?a=1&amp;b=2"');
    expect(mail.html).toContain('GS-27 &amp; Friends');
    expect(mail.text).toContain(
      'Open the programme: https://pic.org/programme?a=1&b=2',
    );
    expect(mail.text).toContain('you have a ticket to GS-27 & Friends');
  });

  it('leaves the button out without one', () => {
    const mail = renderCampaign(
      { subject: 's', body: 'b', buttonLabel: null, buttonUrl: null },
      ada,
      'GS-27',
    );
    expect(mail.html).not.toContain('border-radius:8px"><a');
    expect(mail.text.split('\n\n')).toHaveLength(2);
  });

  describe('design', () => {
    const content = {
      subject: 'Hello',
      body: 'Dear {{first_name}},',
      buttonLabel: 'Programme',
      buttonUrl: 'https://pic.org/p',
    };

    it('keeps the PIC layout without a design', () => {
      const { html } = renderCampaign(
        { ...content, design: null },
        ada,
        'GS-27',
      );
      expect(html).toContain('background:#002d74;padding:20px 28px');
      expect(html).toContain('Policy Innovation Centre</p>');
      expect(html).not.toContain('<img');
    });

    it('shows the logo and banner, in the chosen colours, with the footer line', () => {
      const { html, text } = renderCampaign(
        {
          ...content,
          design: {
            ...DEFAULT_DESIGN,
            logo: 'campaigns/a',
            banner: 'campaigns/b',
            headerColor: '#ffffff',
            buttonColor: '#d2042d',
            eyebrow: '',
            footer: 'Questions? events@pic.org <b>',
          },
        },
        ada,
        'GS-27',
        null,
        null,
        { logo: 'https://api/img/logo', banner: 'https://api/img/banner' },
      );
      expect(html).toContain('<img src="https://api/img/logo"');
      expect(html).toContain('<img src="https://api/img/banner"');
      // a white header gets dark text, and the hidden line is not there
      expect(html).toContain('background:#ffffff;padding:20px 28px');
      expect(html).toContain('color:#111111">GS-27</p>');
      expect(html).not.toContain('text-transform:uppercase');
      expect(html).toContain('background:#d2042d;border-radius:8px');
      expect(html).toContain('Questions? events@pic.org &lt;b&gt;<br><br>');
      expect(text).toContain('Questions? events@pic.org <b>');
    });

    it('leaves the header out when it would be empty', () => {
      const { html } = renderCampaign(
        {
          ...content,
          design: { ...DEFAULT_DESIGN, eyebrow: '', showEventName: false },
        },
        ada,
        'GS-27',
      );
      expect(html).not.toContain('padding:20px 28px');
    });

    it('picks light text for dark colours and dark text for light ones', () => {
      expect(readsLight('#002d74')).toBe(true);
      expect(readsLight('#ffffff')).toBe(false);
      expect(readsLight('#f2b705')).toBe(false);
    });
  });
});
