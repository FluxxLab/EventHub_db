import type { PaymentMethod } from './payment-provider.interface';

/** Currencies a ticket tier can carry a price in. NGN is the base and always required. */
export const CURRENCIES = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Admin fee per order, whole units of each currency; zero on free orders. */
export const ADMIN_FEE: Record<Currency, number> = {
  NGN: 500,
  USD: 1,
  GHS: 8,
  KES: 100,
  ZAR: 15,
};

export interface PaymentOptions {
  country: string;
  countryName: string;
  currency: Currency;
  /** Which provider settles this country; the app never sees provider details. */
  provider: 'paystack' | 'flutterwave' | 'stripe';
  methods: { id: PaymentMethod; label: string }[];
}

const CARD = { id: 'card' as const, label: 'Debit or Credit Card' };
const TRANSFER = { id: 'transfer' as const, label: 'Bank Transfer' };
const USSD = { id: 'ussd' as const, label: 'USSD' };
const MOBILE_MONEY = { id: 'wallet' as const, label: 'Mobile Money' };

/**
 * What a delegate paying from each country gets. Billing country, not GPS:
 * a Ghanaian delegate at the venue in Abuja still pays in cedis from a
 * Ghanaian card. Anywhere not listed pays in dollars by card.
 */
const BY_COUNTRY: Record<string, Omit<PaymentOptions, 'country'>> = {
  NG: {
    countryName: 'Nigeria',
    currency: 'NGN',
    provider: 'paystack',
    methods: [CARD, TRANSFER, USSD],
  },
  GH: {
    countryName: 'Ghana',
    currency: 'GHS',
    provider: 'paystack',
    methods: [CARD, MOBILE_MONEY],
  },
  KE: {
    countryName: 'Kenya',
    currency: 'KES',
    provider: 'paystack',
    methods: [CARD, MOBILE_MONEY],
  },
  ZA: {
    countryName: 'South Africa',
    currency: 'ZAR',
    provider: 'paystack',
    methods: [CARD],
  },
  US: {
    countryName: 'United States',
    currency: 'USD',
    provider: 'stripe',
    methods: [CARD],
  },
  GB: {
    countryName: 'United Kingdom',
    currency: 'USD',
    provider: 'stripe',
    methods: [CARD],
  },
};

const DEFAULT: Omit<PaymentOptions, 'country'> = {
  countryName: 'Other',
  currency: 'USD',
  provider: 'stripe',
  methods: [CARD],
};

export const normaliseCountry = (country?: string | null): string =>
  (country ?? 'NG').trim().toUpperCase().slice(0, 2) || 'NG';

export function paymentOptionsFor(country?: string | null): PaymentOptions {
  const code = normaliseCountry(country);
  return { country: code, ...(BY_COUNTRY[code] ?? DEFAULT) };
}

/**
 * How the app guesses a delegate's billing country before they pick one:
 * the international dialling codes of a phone number, regex sources
 * (anchored, no flags, matched after stripping spaces) for a number written
 * the local way without the prefix, e.g. a Nigerian "0801 234 5678", and
 * the lower-case spellings a profile's free-text country field turns up. Only countries
 * that price in their own currency or provider need entries; everyone else
 * lands on "Other".
 */
const HINTS: Record<
  string,
  { dialCodes: string[]; localPatterns: string[]; aliases: string[] }
> = {
  NG: {
    dialCodes: ['+234'],
    localPatterns: ['^0[789][01]\\d{8}$'],
    aliases: ['nigeria'],
  },
  GH: {
    dialCodes: ['+233'],
    localPatterns: ['^0[235]\\d{8}$'],
    aliases: ['ghana'],
  },
  KE: {
    dialCodes: ['+254'],
    localPatterns: ['^0[17]\\d{8}$'],
    aliases: ['kenya'],
  },
  ZA: {
    dialCodes: ['+27'],
    localPatterns: ['^0[6-8]\\d{8}$'],
    aliases: ['south africa', 'rsa'],
  },
  US: {
    dialCodes: ['+1'],
    localPatterns: [],
    aliases: [
      'united states',
      'united states of america',
      'usa',
      'us',
      'america',
    ],
  },
  GB: {
    dialCodes: ['+44'],
    localPatterns: [],
    aliases: [
      'united kingdom',
      'uk',
      'great britain',
      'britain',
      'england',
      'scotland',
      'wales',
      'northern ireland',
    ],
  },
};

export interface PaymentCountry {
  code: string;
  name: string;
  currency: Currency;
  dialCodes: string[];
  /** Regex sources for local-format numbers; see HINTS. */
  localPatterns: string[];
  aliases: string[];
}

/** The picker list for "Paying from". "Other" covers every country not listed. */
export function paymentCountries(): PaymentCountry[] {
  return [
    ...Object.entries(BY_COUNTRY).map(([code, o]) => ({
      code,
      name: o.countryName,
      currency: o.currency,
      dialCodes: HINTS[code]?.dialCodes ?? [],
      localPatterns: HINTS[code]?.localPatterns ?? [],
      aliases: HINTS[code]?.aliases ?? [o.countryName.toLowerCase()],
    })),
    {
      code: 'XX',
      name: 'Other (pay in US dollars)',
      currency: 'USD',
      dialCodes: [],
      localPatterns: [],
      aliases: [],
    },
  ];
}
