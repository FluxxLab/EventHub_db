import { haversineKm, sortByDistance } from './geo';

describe('haversineKm', () => {
  it('is zero for the same point and symmetric', () => {
    expect(haversineKm(9, 7, 9, 7)).toBe(0);
    expect(haversineKm(9.0579, 7.4951, 6.5244, 3.3792)).toBeCloseTo(
      haversineKm(6.5244, 3.3792, 9.0579, 7.4951),
      9,
    );
  });

  it('puts Abuja to Lagos at about 525km', () => {
    const km = haversineKm(9.0579, 7.4951, 6.5244, 3.3792);
    expect(km).toBeGreaterThan(510);
    expect(km).toBeLessThan(540);
  });
});

describe('sortByDistance', () => {
  const at = (id: string, lat: number | null, lng: number | null, day = 1) => ({
    id,
    latitude: lat,
    longitude: lng,
    startsAt: new Date(`2027-09-0${day}T08:00:00Z`),
  });

  it('orders nearest first with unpinned items last, by date', () => {
    const sorted = sortByDistance(
      [
        at('none-late', null, null, 5),
        at('far', 6.5244, 3.3792),
        at('none-early', null, null, 2),
        at('near', 9.1, 7.5),
      ],
      9.0579,
      7.4951,
    );
    expect(sorted.map((s) => s.id)).toEqual([
      'near',
      'far',
      'none-early',
      'none-late',
    ]);
    expect(sorted[3].distanceKm).toBeNull();
  });
});
