export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * A device registered through POST /notifications/register. `platform` decides
 * the transport: iOS hands back a raw APNs device token, Android an FCM
 * registration token, and the two are not interchangeable.
 */
export interface PushTarget {
  token: string;
  platform: string;
}

/**
 * What the app needs to open the right screen when someone taps the banner.
 *
 * Strings only, and few of them: APNs and FCM both cap the payload, and both
 * flatten values to strings on the way through, so anything richer would be
 * lost or truncated in transit. Without this the app can only ever open where
 * it was last left, which is why a tap used to do nothing useful.
 */
export interface PushData {
  /** Why this was sent: 'announcement', 'network', 'session', 'trivia'. */
  category?: string;
  /** The row in the delegate's inbox, when there is one. */
  notificationId?: string;
  /** The session this is about, when it is about one. */
  sessionId?: string;
  /** An address outside the app, when the announcement points at one. */
  linkUrl?: string;
}

export interface PushSender {
  sendToTokens(
    targets: PushTarget[],
    title: string,
    body: string,
    data?: PushData,
  ): Promise<{ invalidTokens: string[] }>;
}

/** Drops empty values and stringifies the rest, as both transports require. */
export function pushDataPayload(data?: PushData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}
