/**
 * An edition's name badge: the card size, the band colour, what is printed
 * under the name, and a colour per ticket tier so the door can tell VIPs
 * from across the hall. The console draws and prints it; the API only keeps
 * it, like the certificate design.
 */

/** A6 (105 × 148 mm, portrait), 4 × 3 in (landscape), CR80 (ID card, portrait). */
export const BADGE_SIZES = ['a6', '4x3', 'cr80'] as const;
export type BadgeSize = (typeof BADGE_SIZES)[number];

export const BADGE_FIELDS = [
  'photo',
  'title',
  'organisation',
  'country',
  'tier',
  'code',
  'qr',
] as const;
export type BadgeField = (typeof BADGE_FIELDS)[number];

/** The parts placed on artwork: the photo, the name with its details, and the QR with the code. */
export const BADGE_PARTS = ['photo', 'who', 'scan'] as const;
export type BadgePart = (typeof BADGE_PARTS)[number];

/** Where a part's centre sits on the badge, as fractions of its width and height, and how big it is. */
export interface BadgePlacement {
  x: number;
  y: number;
  /** 1 is the standard size for the badge. */
  scale: number;
}

/** Artwork images the console may upload. */
export const BADGE_ARTWORK_TYPES = ['image/png', 'image/jpeg'] as const;

export interface BadgeDesign {
  size: BadgeSize;
  /** The header band, as #rrggbb. */
  accent: string;
  /** Printed under the name, in this order. */
  fields: BadgeField[];
  /** The footer band's colour for a tier, by tier name; others use the accent. */
  tierColours: { tier: string; colour: string }[];
  /**
   * The storage key of the organisers' own background, printed edge to edge
   * in place of the header band; null for the standard layout.
   */
  artwork: string | null;
  /** Where each part sits on the artwork; null without artwork. */
  layout: Record<BadgePart, BadgePlacement> | null;
}

/** The design as the console reads it: with a short-lived link to show and print the artwork. */
export type BadgeDesignView = BadgeDesign & { artworkUrl: string | null };

/** A holder's badge: what is printed, and the door QR. */
export interface BadgeHolder {
  ticketId: string;
  code: string;
  name: string;
  title: string | null;
  organisation: string | null;
  country: string | null;
  /** A short-lived link to their profile photo; null without one. */
  photo: string | null;
  tierName: string;
  ticketTypeId: string;
  section: string;
  quantity: number;
  /** The signed admission payload (`PICT1.…`), exactly what the gate scans. */
  qr: string;
  /** People let in on the ticket so far. */
  admitted: number;
}

/** Enough for any summit; printing more at once is not what a desk does. */
export const BADGE_LIST_LIMIT = 5000;
