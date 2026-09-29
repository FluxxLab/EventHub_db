/** Mean Earth radius in kilometres, the usual figure for haversine. */
const EARTH_RADIUS_KM = 6371;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface Placed {
  latitude: number | null;
  longitude: number | null;
  startsAt: Date;
}

/**
 * Nearest first, each item carrying its distance to one decimal. Items with
 * no coordinates go last, soonest first among themselves, with a null
 * distance: an edition the organiser has not pinned is still worth listing,
 * it just cannot claim to be close.
 */
export function sortByDistance<T extends Placed>(
  items: T[],
  lat: number,
  lng: number,
): (T & { distanceKm: number | null })[] {
  return items
    .map((item) => ({
      ...item,
      distanceKm:
        item.latitude === null || item.longitude === null
          ? null
          : Math.round(
              haversineKm(lat, lng, item.latitude, item.longitude) * 10,
            ) / 10,
    }))
    .sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) {
        return a.startsAt.getTime() - b.startsAt.getTime();
      }
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return (
        a.distanceKm - b.distanceKm ||
        a.startsAt.getTime() - b.startsAt.getTime()
      );
    });
}
