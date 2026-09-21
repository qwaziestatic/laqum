import { describe, expect, it } from 'vitest';
import { haversineMeters } from './geo.js';

const BOLE = { latitude: 9.0092, longitude: 38.7869 };
const PIASSA = { latitude: 9.0348, longitude: 38.7508 };

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(BOLE, BOLE)).toBe(0);
  });

  it('measures the two seeded Addis lots at roughly 4.8 km apart', () => {
    // Independently: ~2.85 km north-south, ~3.97 km east-west => ~4.9 km.
    const d = haversineMeters(BOLE, PIASSA);
    expect(d).toBeGreaterThan(4_500);
    expect(d).toBeLessThan(5_200);
  });

  it('is symmetric', () => {
    expect(haversineMeters(BOLE, PIASSA)).toBeCloseTo(haversineMeters(PIASSA, BOLE), 6);
  });

  it('measures one degree of latitude as about 111 km anywhere', () => {
    const atEquator = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    const atAddis = haversineMeters(
      { latitude: 9, longitude: 38.75 },
      { latitude: 10, longitude: 38.75 },
    );
    expect(atEquator).toBeGreaterThan(111_000);
    expect(atEquator).toBeLessThan(111_400);
    expect(atAddis).toBeCloseTo(atEquator, 0);
  });

  it('shrinks a degree of longitude with latitude', () => {
    const equator = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const addis = haversineMeters({ latitude: 9, longitude: 38 }, { latitude: 9, longitude: 39 });
    // cos(9 degrees) is about 0.9877.
    expect(addis / equator).toBeCloseTo(Math.cos((9 * Math.PI) / 180), 3);
  });

  it('handles antipodal points without NaN from floating point drift', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBeGreaterThan(20_000_000);
  });

  it('measures a walk across a parking lot in tens of metres', () => {
    // 0.0005 degrees of latitude is about 55 m: the scale the booking
    // proximity check actually operates at.
    const d = haversineMeters(BOLE, { ...BOLE, latitude: BOLE.latitude + 0.0005 });
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
  });
});
