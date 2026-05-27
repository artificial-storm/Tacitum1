import { describe, expect, test } from 'vitest';
import { DotFieldModel } from './DotFieldModel';
import type { DotFieldUpdate } from './DotFieldModel';

const makeFrame = (overrides: Partial<DotFieldUpdate['audio']> = {}, speechOverrides: Partial<DotFieldUpdate['speech']> = {}): DotFieldUpdate => ({
  audio: {
    timestamp: 100,
    rms: 0.3,
    smoothedRms: 0.3,
    noiseFloor: 0.02,
    transient: 0.5,
    spectralCentroid: 0.4,
    brightness: 0.7,
    frequencyBins: Array.from({ length: 16 }, () => 0),
    lowBand: 0.2,
    midBand: 0.4,
    highBand: 0.2,
    rhythm: 0.5,
    roughPitch: null,
    voiceTexture: 0.4,
    ...overrides,
  },
  speech: {
    timestamp: overrides.timestamp ?? 100,
    state: 'activeSpeech',
    confidence: 0.8,
    speakingIntensity: 0.8,
    speechStart: true,
    speechEnd: false,
    longPause: false,
    possibleOverlap: false,
    ...speechOverrides,
  },
  speaker: {
    timestamp: overrides.timestamp ?? 100,
    activeSpeakerId: 'speaker-a',
    overlap: false,
    speakers: [],
  },
});

describe('DotFieldModel', () => {
  test('generates a stable perspective dot plane', () => {
    const first = new DotFieldModel({ rings: 5, dotsPerRing: 12, radius: 100 });
    const second = new DotFieldModel({ rings: 5, dotsPerRing: 12, radius: 100 });

    expect(first.dots).toHaveLength(second.dots.length);
    expect(first.dots[0]).toEqual(second.dots[0]);
    expect(first.dots.every((dot) => Math.abs(dot.baseX) <= 125 && Math.abs(dot.baseY) <= 80)).toBe(true);
    expect(first.dots.some((dot) => dot.baseZ > 0)).toBe(true);
  });

  test('updates dots with speech energy and speaker influence', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const before = model.dots.map((dot) => dot.opacity);

    model.update(makeFrame());

    expect(model.dots.some((dot, index) => dot.opacity !== before[index])).toBe(true);
    expect(model.ripples.length).toBeGreaterThanOrEqual(3);
    expect(model.dots.some((dot) => dot.z < dot.baseZ)).toBe(true);
  });

  test('lets DOT ripples move both above and below the base plane', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1.2, duration: 3200, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 580, rms: 0.12, smoothedRms: 0.12, transient: 0.02, lowBand: 0.14, midBand: 0.2, highBand: 0.1 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    expect(model.dots.some((dot) => dot.z < dot.baseZ)).toBe(true);
    expect(model.dots.some((dot) => dot.z > dot.baseZ)).toBe(true);
    expect(Math.min(...model.dots.map((dot) => dot.lift))).toBeLessThan(-0.02);
  });

  test('keeps DOT rows rectangular in world space before camera rotation', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame());

    const rowSpans = model.rows.map((row) => {
      const xPositions = row.map((dot) => dot.x);

      return Math.max(...xPositions) - Math.min(...xPositions);
    });
    const distantSpan = rowSpans[0];
    const foregroundSpan = rowSpans[rowSpans.length - 1];

    expect(distantSpan).toBeCloseTo(foregroundSpan, 4);
    expect(Math.min(...rowSpans)).toBeGreaterThan(Math.max(...rowSpans) * 0.99);
  });

  test('builds DOT on a square world-space plane', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const xSpan = Math.max(...model.dots.map((dot) => dot.baseX)) - Math.min(...model.dots.map((dot) => dot.baseX));
    const ySpan = Math.max(...model.dots.map((dot) => dot.baseY)) - Math.min(...model.dots.map((dot) => dot.baseY));
    const zSpan = Math.max(...model.dots.map((dot) => dot.baseZ)) - Math.min(...model.dots.map((dot) => dot.baseZ));

    expect(xSpan).toBeCloseTo(Math.hypot(ySpan, zSpan), 4);
  });

  test('keeps row edges aligned so the DOT plane completes the rectangle', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    const leftEdges = model.rows.map((row) => row[0].baseX.toFixed(3));
    const rightEdges = model.rows.map((row) => row[row.length - 1].baseX.toFixed(3));

    expect(new Set(leftEdges).size).toBe(1);
    expect(new Set(rightEdges).size).toBe(1);
  });

  test('keeps projected foreground DOT corners inside the visible plane', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame());

    const foregroundRow = model.rows[model.rows.length - 1];
    const foregroundMaxX = Math.max(...foregroundRow.map((dot) => Math.abs(dot.x)));

    expect(foregroundMaxX).toBeLessThanOrEqual(model.options.radius * 1.2);
  });

  test('moves ripple origins with volume as well as frequency', () => {
    const quiet = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const loud = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    quiet.update(makeFrame({ rms: 0.01, smoothedRms: 0.01, transient: 0.22, spectralCentroid: 0.48, lowBand: 0.18, midBand: 0.32, highBand: 0.16 }));
    loud.update(makeFrame({ rms: 0.06, smoothedRms: 0.06, transient: 0.22, spectralCentroid: 0.48, lowBand: 0.18, midBand: 0.32, highBand: 0.16 }));

    const quietOrigin = quiet.ripples[0];
    const loudOrigin = loud.ripples[0];
    const originDistance = Math.hypot(loudOrigin.originX - quietOrigin.originX, loudOrigin.originY - quietOrigin.originY);

    expect(originDistance).toBeGreaterThan(4);
  });

  test('creates several spread-out ripple emitters for one DOT trigger', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ rms: 0.06, smoothedRms: 0.06, transient: 0.24, spectralCentroid: 0.48, lowBand: 0.18, midBand: 0.34, highBand: 0.16 }));

    const originXs = model.ripples.map((ripple) => ripple.originX);
    const originYs = model.ripples.map((ripple) => ripple.originY);

    expect(model.ripples.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...originXs) - Math.min(...originXs)).toBeGreaterThan(40);
    expect(Math.max(...originYs) - Math.min(...originYs)).toBeGreaterThan(12);
  });

  test('stagger DOT ripple emitter starts inside one trigger', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, lowBand: 0.18, midBand: 0.38, highBand: 0.24 }));

    const timestamps = model.ripples.map((ripple) => ripple.timestamp);

    expect(new Set(timestamps.map((timestamp) => timestamp.toFixed(3))).size).toBeGreaterThan(1);
    expect(Math.max(...timestamps) - Math.min(...timestamps)).toBeGreaterThan(24);
  });

  test('uses detailed frequency peaks to place DOT emitters', () => {
    const lowPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const highPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const lowBins = Array.from({ length: 16 }, () => 0.02);
    const highBins = Array.from({ length: 16 }, () => 0.02);

    lowBins[2] = 0.9;
    highBins[13] = 0.9;

    lowPeak.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, spectralCentroid: 0.5, lowBand: 0.24, midBand: 0.24, highBand: 0.24, frequencyBins: lowBins }));
    highPeak.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, spectralCentroid: 0.5, lowBand: 0.24, midBand: 0.24, highBand: 0.24, frequencyBins: highBins }));

    const averageOriginX = (model: DotFieldModel): number => model.ripples.reduce((sum, ripple) => sum + ripple.originX, 0) / model.ripples.length;

    expect(averageOriginX(highPeak)).toBeGreaterThan(averageOriginX(lowPeak) + 34);
  });

  test('keeps frequency-mapped DOT emitters closer to the plane center', () => {
    const lowPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const highPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const lowBins = Array.from({ length: 16 }, () => 0.02);
    const highBins = Array.from({ length: 16 }, () => 0.02);

    lowBins[2] = 0.9;
    highBins[13] = 0.9;

    lowPeak.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, spectralCentroid: 0.5, lowBand: 0.24, midBand: 0.24, highBand: 0.24, frequencyBins: lowBins }));
    highPeak.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, spectralCentroid: 0.5, lowBand: 0.24, midBand: 0.24, highBand: 0.24, frequencyBins: highBins }));

    const averageOriginX = (model: DotFieldModel): number => model.ripples.reduce((sum, ripple) => sum + ripple.originX, 0) / model.ripples.length;

    expect(Math.abs(averageOriginX(lowPeak))).toBeLessThan(42);
    expect(Math.abs(averageOriginX(highPeak))).toBeLessThan(42);
  });

  test('keeps separate frequency peaks spread across both sides with distinct heights', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const bins = Array.from({ length: 16 }, () => 0.02);

    bins[3] = 0.95;
    bins[8] = 0.42;
    bins[12] = 0.68;

    model.update(makeFrame({ rms: 0.14, smoothedRms: 0.14, transient: 0.28, spectralCentroid: 0.5, lowBand: 0.18, midBand: 0.42, highBand: 0.3, frequencyBins: bins }));

    expect(model.ripples.some((ripple) => ripple.originX < -8)).toBe(true);
    expect(model.ripples.some((ripple) => ripple.originX > 8)).toBe(true);
    expect(Math.max(...model.ripples.map((ripple) => ripple.intensity)) - Math.min(...model.ripples.map((ripple) => ripple.intensity))).toBeGreaterThan(0.32);
  });

  test('varies DOT ripple heights from volume and local frequency energy', () => {
    const quiet = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const loud = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    quiet.update(makeFrame({ rms: 0.03, smoothedRms: 0.03, transient: 0.24, lowBand: 0.08, midBand: 0.26, highBand: 0.08 }));
    loud.update(makeFrame({ rms: 0.32, smoothedRms: 0.32, transient: 0.24, lowBand: 0.08, midBand: 0.26, highBand: 0.08 }));

    const quietIntensities = quiet.ripples.map((ripple) => ripple.intensity);
    const loudIntensities = loud.ripples.map((ripple) => ripple.intensity);

    expect(Math.max(...loudIntensities)).toBeGreaterThan(Math.max(...quietIntensities) * 1.45);
    expect(new Set(loudIntensities.map((intensity) => intensity.toFixed(4))).size).toBeGreaterThan(1);
  });

  test('keeps DOT ripple lifetimes long enough to complete their flow', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.28, lowBand: 0.2, midBand: 0.34, highBand: 0.18 }));

    expect(Math.max(...model.ripples.map((ripple) => ripple.duration))).toBeGreaterThanOrEqual(7600);
    expect(Math.max(...model.ripples.map((ripple) => ripple.duration))).toBeLessThanOrEqual(9800);
  });

  test('moves the DOT ripple front steadily after a trigger', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.08, smoothedRms: 0.08, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const strongestDot = model.dots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), model.dots[0]);
    const strongestDistance = Math.hypot(strongestDot.baseX, strongestDot.baseY * 1.18) / model.options.radius;

    expect(strongestDistance).toBeGreaterThan(0.16);
  });

  test('starts the DOT ripple travel without rushing after a trigger', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1.1, duration: 3000, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 360, rms: 0.08, smoothedRms: 0.08, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const strongestDot = model.dots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), model.dots[0]);
    const strongestDistance = Math.hypot(strongestDot.baseX, strongestDot.baseY * 1.18) / model.options.radius;

    expect(strongestDistance).toBeGreaterThan(0.12);
    expect(strongestDistance).toBeLessThan(0.32);
  });

  test('ramps DOT source lift instead of popping to full height before travel', () => {
    const start = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });
    const moving = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });
    const ripple = { timestamp: 100, intensity: 1.15, duration: 3000, originX: 0, originY: 0, speakerId: null };

    start.ripples = [ripple];
    moving.ripples = [ripple];
    start.update(makeFrame({ timestamp: 100, rms: 0.22, smoothedRms: 0.22, transient: 0, lowBand: 0.14, midBand: 0.22, highBand: 0.1 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));
    moving.update(makeFrame({ timestamp: 260, rms: 0.22, smoothedRms: 0.22, transient: 0, lowBand: 0.14, midBand: 0.22, highBand: 0.1 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const startMaxLift = Math.max(...start.dots.map((dot) => dot.lift));
    const movingMaxLift = Math.max(...moving.dots.map((dot) => dot.lift));
    const strongestMovingDot = moving.dots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), moving.dots[0]);
    const strongestDistance = Math.hypot(strongestMovingDot.baseX, strongestMovingDot.baseY * 1.18) / moving.options.radius;

    expect(startMaxLift).toBeLessThan(0.12);
    expect(movingMaxLift).toBeGreaterThan(startMaxLift * 1.6);
    expect(strongestDistance).toBeGreaterThan(0.03);
  });

  test('scales DOT source lift from ongoing sound level', () => {
    const quiet = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });
    const loud = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });
    const ripple = { timestamp: 100, intensity: 0.9, duration: 3000, originX: 0, originY: 0, speakerId: null };

    quiet.ripples = [ripple];
    loud.ripples = [ripple];
    quiet.update(makeFrame({ timestamp: 220, rms: 0.012, smoothedRms: 0.012, transient: 0, lowBand: 0.01, midBand: 0.012, highBand: 0.008 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));
    loud.update(makeFrame({ timestamp: 220, rms: 0.32, smoothedRms: 0.32, transient: 0, lowBand: 0.24, midBand: 0.3, highBand: 0.18 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const sourceLift = (model: DotFieldModel): number => {
      const sourceDot = model.dots.reduce((closest, dot) => {
        const closestDistance = Math.hypot(closest.baseX, closest.baseY * 1.18);
        const dotDistance = Math.hypot(dot.baseX, dot.baseY * 1.18);

        return dotDistance < closestDistance ? dot : closest;
      }, model.dots[0]);

      return sourceDot.lift;
    };

    expect(sourceLift(quiet)).toBeGreaterThan(0.005);
    expect(sourceLift(loud)).toBeGreaterThan(sourceLift(quiet) * 1.8);
  });

  test('maps very soft frequency peaks into adaptive DOT origins across the flat plane', () => {
    const lowPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const highPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const lowBins = Array.from({ length: 32 }, () => 0.001);
    const highBins = Array.from({ length: 32 }, () => 0.001);

    lowBins[5] = 0.026;
    highBins[24] = 0.026;
    lowPeak.update(makeFrame({ rms: 0.006, smoothedRms: 0.006, transient: 0.006, spectralCentroid: 0.16, lowBand: 0.006, midBand: 0.005, highBand: 0.004, frequencyBins: lowBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));
    highPeak.update(makeFrame({ rms: 0.006, smoothedRms: 0.006, transient: 0.006, spectralCentroid: 0.78, lowBand: 0.004, midBand: 0.005, highBand: 0.006, frequencyBins: highBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));

    const averageOriginX = (model: DotFieldModel): number => model.ripples.reduce((sum, ripple) => sum + ripple.originX, 0) / model.ripples.length;
    const averageOriginY = (model: DotFieldModel): number => model.ripples.reduce((sum, ripple) => sum + ripple.originY, 0) / model.ripples.length;

    expect(lowPeak.ripples.length).toBeGreaterThan(0);
    expect(highPeak.ripples.length).toBeGreaterThan(0);
    expect(averageOriginX(highPeak)).toBeGreaterThan(averageOriginX(lowPeak) + 30);
    expect(Math.abs(averageOriginY(highPeak) - averageOriginY(lowPeak))).toBeGreaterThan(8);
  });

  test('keeps very soft DOT input visible while high volume makes a larger impact', () => {
    const soft = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const loud = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const softBins = Array.from({ length: 32 }, () => 0.001);
    const loudBins = Array.from({ length: 32 }, () => 0.02);

    softBins[11] = 0.024;
    loudBins[11] = 0.72;
    soft.update(makeFrame({ timestamp: 100, rms: 0.006, smoothedRms: 0.006, transient: 0.006, spectralCentroid: 0.36, lowBand: 0.005, midBand: 0.006, highBand: 0.004, frequencyBins: softBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));
    soft.update(makeFrame({ timestamp: 220, rms: 0.006, smoothedRms: 0.006, transient: 0.004, spectralCentroid: 0.36, lowBand: 0.005, midBand: 0.006, highBand: 0.004, frequencyBins: softBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));
    loud.update(makeFrame({ timestamp: 100, rms: 0.34, smoothedRms: 0.34, transient: 0.2, spectralCentroid: 0.36, lowBand: 0.16, midBand: 0.34, highBand: 0.12, frequencyBins: loudBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));
    loud.update(makeFrame({ timestamp: 220, rms: 0.34, smoothedRms: 0.34, transient: 0.08, spectralCentroid: 0.36, lowBand: 0.16, midBand: 0.34, highBand: 0.12, frequencyBins: loudBins }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));

    const softLift = Math.max(...soft.dots.map((dot) => dot.lift));
    const loudLift = Math.max(...loud.dots.map((dot) => dot.lift));

    expect(soft.ripples.length).toBeGreaterThan(0);
    expect(softLift).toBeGreaterThan(0.005);
    expect(loudLift).toBeGreaterThan(softLift * 3);
  });

  test('shows very low volume DOT input as a small visual displacement at default Lift', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const softBins = Array.from({ length: 32 }, () => 0.001);

    softBins[10] = 0.009;

    for (let index = 0; index < 4; index += 1) {
      model.update(makeFrame({
        timestamp: 100 + index * 54,
        rms: 0.0025,
        smoothedRms: 0.0025,
        transient: index === 0 ? 0.004 : 0.001,
        spectralCentroid: 0.32,
        lowBand: 0.002,
        midBand: 0.003,
        highBand: 0.002,
        frequencyBins: softBins,
      }, {
        speakingIntensity: 0,
        speechStart: false,
        state: 'listening',
      }));
    }

    const strongestDisplacement = Math.max(...model.dots.map((dot) => Math.abs(dot.y - dot.baseY)));

    expect(model.ripples.length).toBeGreaterThan(0);
    expect(strongestDisplacement).toBeGreaterThan(0.03);
  });

  test('keeps fading DOT after-ripples alive a bit longer', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.2, smoothedRms: 0.2, transient: 0.28, lowBand: 0.16, midBand: 0.3, highBand: 0.12 }));
    model.update(makeFrame({ timestamp: 260, rms: 0.07, smoothedRms: 0.07, transient: 0, lowBand: 0.06, midBand: 0.08, highBand: 0.04 }, {
      speechStart: false,
    }));

    expect(Math.max(...model.ripples.map((ripple) => ripple.duration))).toBeGreaterThan(6800);
  });

  test('keeps DOT ripple peaks sharper than the surrounding field', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1.1, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.08, smoothedRms: 0.08, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const lifts = model.dots.map((dot) => dot.lift);
    const maxLift = Math.max(...lifts);
    const broadPeakCount = lifts.filter((lift) => lift > maxLift * 0.6).length;

    expect(broadPeakCount).toBeLessThan(model.dots.length * 0.14);
  });

  test('starts DOT ripples from a compact middle peak', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1.2, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 220, rms: 0.18, smoothedRms: 0.18, transient: 0, lowBand: 0.14, midBand: 0.22, highBand: 0.1 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const liftsByDistance = model.dots
      .map((dot) => ({
        lift: dot.lift,
        distance: Math.hypot(dot.baseX, dot.baseY * 1.18) / model.options.radius,
      }))
      .filter((dot) => dot.lift > 0.005);
    const maxLift = Math.max(...liftsByDistance.map((dot) => dot.lift));
    const broadPeakCount = liftsByDistance.filter((dot) => dot.lift > maxLift * 0.42).length;
    const strongestDistance = liftsByDistance.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), liftsByDistance[0]).distance;

    expect(strongestDistance).toBeLessThan(0.12);
    expect(broadPeakCount).toBeLessThanOrEqual(10);
  });

  test('keeps travelling DOT ripple crests thin while they expand farther', () => {
    const model = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const lateModel = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const ripple = { timestamp: 100, intensity: 1.2, duration: 4200, originX: 0, originY: 0, speakerId: null };

    model.ripples = [ripple];
    model.update(makeFrame({ timestamp: 620, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const lifts = model.dots.map((dot) => ({
      lift: dot.lift,
      distance: Math.hypot(dot.baseX, dot.baseY * 1.18) / model.options.radius,
    }));
    const maxLift = Math.max(...lifts.map((dot) => dot.lift));
    const highLiftCount = lifts.filter((dot) => dot.lift > maxLift * 0.55).length;

    lateModel.ripples = [ripple];
    lateModel.update(makeFrame({ timestamp: 1240, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const lateMaxLift = Math.max(...lateModel.dots.map((dot) => dot.lift));
    const lateStrongest = lateModel.dots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), lateModel.dots[0]);
    const lateDistance = Math.hypot(lateStrongest.baseX, lateStrongest.baseY * 1.18) / lateModel.options.radius;

    expect(highLiftCount).toBeLessThan(model.dots.length * 0.045);
    expect(lateDistance).toBeGreaterThan(0.84);
    expect(lateMaxLift).toBeLessThan(maxLift * 0.9);
  });

  test('runs a second lower-intensity DOT ripple pass from the origin', () => {
    const firstPass = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const betweenPasses = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const secondPass = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const ripple = { timestamp: 100, intensity: 1.25, duration: 5200, originX: 0, originY: 0, speakerId: null };
    const sourceLift = (model: DotFieldModel): number => {
      const sourceDots = model.dots.filter((dot) => Math.hypot(dot.baseX, dot.baseY * 1.18) / model.options.radius < 0.24);

      return Math.max(...sourceDots.map((dot) => dot.lift));
    };

    firstPass.ripples = [ripple];
    betweenPasses.ripples = [ripple];
    secondPass.ripples = [ripple];
    firstPass.update(makeFrame({ timestamp: 220, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));
    betweenPasses.update(makeFrame({ timestamp: 1180, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));
    secondPass.update(makeFrame({ timestamp: 1340, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const firstSourceLift = sourceLift(firstPass);
    const betweenSourceLift = sourceLift(betweenPasses);
    const secondSourceLift = sourceLift(secondPass);
    expect(betweenSourceLift).toBeLessThan(firstSourceLift * 0.9);
    expect(secondSourceLift).toBeGreaterThan(0.05);
    expect(secondSourceLift).toBeLessThan(betweenSourceLift * 0.45);
    expect(secondSourceLift).toBeLessThan(firstSourceLift * 0.55);
  });

  test('keeps DOT ripple energy continuous while the second pass starts', () => {
    const between = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const restarting = new DotFieldModel({ rings: 8, dotsPerRing: 20, radius: 80 });
    const ripple = { timestamp: 100, intensity: 1.2, duration: 5600, originX: 0, originY: 0, speakerId: null };
    const sourceLift = (model: DotFieldModel): number => {
      const sourceDots = model.dots.filter((dot) => Math.hypot(dot.baseX, dot.baseY * 1.18) / model.options.radius < 0.24);

      return Math.max(...sourceDots.map((dot) => dot.lift));
    };

    between.ripples = [ripple];
    restarting.ripples = [ripple];
    between.update(makeFrame({ timestamp: 1180, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));
    restarting.update(makeFrame({ timestamp: 1340, rms: 0.12, smoothedRms: 0.12, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const betweenMax = Math.max(...between.dots.map((dot) => dot.lift));
    const restartingMax = Math.max(...restarting.dots.map((dot) => dot.lift));

    expect(betweenMax).toBeGreaterThan(0.045);
    expect(sourceLift(restarting)).toBeGreaterThan(0.012);
    expect(restartingMax).toBeGreaterThan(betweenMax * 0.7);
  });

  test('places frequency-reactive DOT origins around the plane center', () => {
    const lowPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const highPeak = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const lowBins = Array.from({ length: 32 }, () => 0.002);
    const highBins = Array.from({ length: 32 }, () => 0.002);

    lowBins[4] = 0.8;
    highBins[27] = 0.8;

    lowPeak.update(makeFrame({ rms: 0.09, smoothedRms: 0.09, transient: 0.26, spectralCentroid: 0.18, lowBand: 0.3, midBand: 0.12, highBand: 0.08, frequencyBins: lowBins }));
    highPeak.update(makeFrame({ rms: 0.09, smoothedRms: 0.09, transient: 0.26, spectralCentroid: 0.82, lowBand: 0.08, midBand: 0.12, highBand: 0.3, frequencyBins: highBins }));

    const averageOrigin = (model: DotFieldModel): { x: number; y: number } => ({
      x: model.ripples.reduce((sum, ripple) => sum + ripple.originX, 0) / model.ripples.length,
      y: model.ripples.reduce((sum, ripple) => sum + ripple.originY, 0) / model.ripples.length,
    });
    const lowOrigin = averageOrigin(lowPeak);
    const highOrigin = averageOrigin(highPeak);

    expect(Math.hypot(lowOrigin.x, lowOrigin.y)).toBeLessThan(48);
    expect(Math.hypot(highOrigin.x, highOrigin.y)).toBeLessThan(48);
    expect(Math.hypot(highOrigin.x - lowOrigin.x, highOrigin.y - lowOrigin.y)).toBeGreaterThan(16);
  });

  test('lets DOT ripples pull dots below the default plane height', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.setRippleHeightScale(0.75);
    model.ripples = [{ timestamp: 100, intensity: 1.15, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.08, smoothedRms: 0.08, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const belowPlaneDots = model.dots.filter((dot) => {
      const baselineY = dot.baseY;

      return dot.y > baselineY + 0.2 && dot.z > dot.baseZ;
    });

    expect(belowPlaneDots.length).toBeGreaterThan(0);
    expect(Math.min(...model.dots.map((dot) => dot.lift))).toBeLessThan(-0.01);
  });

  test('keeps DOT ripples signed with larger dots on the upward crest', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.setRippleHeightScale(0.75);
    model.ripples = [{ timestamp: 100, intensity: 1.25, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.1, smoothedRms: 0.1, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const upwardDots = model.dots.filter((dot) => dot.lift > 0.02);
    const downwardDots = model.dots.filter((dot) => dot.lift < -0.01);
    const strongestUpward = upwardDots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), upwardDots[0]);
    const strongestDownward = downwardDots.reduce((strongest, dot) => (dot.lift < strongest.lift ? dot : strongest), downwardDots[0]);

    expect(upwardDots.length).toBeGreaterThan(0);
    expect(downwardDots.length).toBeGreaterThan(0);
    expect(strongestUpward.lift).toBeGreaterThan(Math.abs(strongestDownward.lift) * 1.35);
    expect(strongestUpward.radius).toBeGreaterThan(strongestDownward.radius * 1.22);
  });

  test('renders DOT crests upward first with a smaller downward follow-through', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.setRippleHeightScale(0.75);
    model.ripples = [{ timestamp: 100, intensity: 1.35, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.1, smoothedRms: 0.1, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const offsets = model.dots.map((dot) => {
      const baselineY = dot.baseY;

      return {
        screenOffset: dot.y - baselineY,
        depthOffset: dot.z - dot.baseZ,
      };
    });
    const upwardCrest = offsets.reduce((strongest, offset) => (offset.screenOffset < strongest.screenOffset ? offset : strongest), offsets[0]);
    const downwardFollowThrough = offsets.reduce((strongest, offset) => (offset.screenOffset > strongest.screenOffset ? offset : strongest), offsets[0]);
    const planeNormalDepthRatio = (model.options.radius * 1.6) / 82;

    expect(upwardCrest.screenOffset).toBeLessThan(-19.5);
    expect(upwardCrest.depthOffset).toBeCloseTo(upwardCrest.screenOffset * planeNormalDepthRatio, 4);
    expect(downwardFollowThrough.screenOffset).toBeGreaterThan(1);
    expect(downwardFollowThrough.depthOffset).toBeCloseTo(downwardFollowThrough.screenOffset * planeNormalDepthRatio, 4);
    expect(Math.abs(upwardCrest.screenOffset)).toBeGreaterThan(downwardFollowThrough.screenOffset * 1.8);
  });

  test('moves DOT crests perpendicular to the plane instead of leaning along the row axis', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.ripples = [{ timestamp: 100, intensity: 1.35, duration: 2600, originX: 0, originY: 0, speakerId: null }];
    model.update(makeFrame({ timestamp: 620, rms: 0.1, smoothedRms: 0.1, transient: 0, lowBand: 0.12, midBand: 0.18, highBand: 0.08 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const strongestUpward = model.dots.reduce((strongest, dot) => (dot.lift > strongest.lift ? dot : strongest), model.dots[0]);
    const planeHeight = model.options.radius * 1.6;
    const planeNormalDepthRatio = planeHeight / 82;
    const rowAxisDot = (strongestUpward.y - strongestUpward.baseY) * planeHeight + (strongestUpward.z - strongestUpward.baseZ) * -82;

    expect(Math.abs(rowAxisDot)).toBeLessThan(0.001);
    expect(strongestUpward.z - strongestUpward.baseZ).toBeCloseTo((strongestUpward.y - strongestUpward.baseY) * planeNormalDepthRatio, 4);
  });

  test('lifts DOT substantially higher on high volume triggers', () => {
    const quiet = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const loud = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    quiet.update(makeFrame({ rms: 0.03, smoothedRms: 0.03, transient: 0.24, lowBand: 0.12, midBand: 0.18, highBand: 0.1 }));
    loud.update(makeFrame({ rms: 0.34, smoothedRms: 0.34, transient: 0.24, lowBand: 0.12, midBand: 0.18, highBand: 0.1 }));
    quiet.update(makeFrame({ timestamp: 220, rms: 0.03, smoothedRms: 0.03, transient: 0.08, lowBand: 0.12, midBand: 0.18, highBand: 0.1 }, { speechStart: false }));
    loud.update(makeFrame({ timestamp: 220, rms: 0.34, smoothedRms: 0.34, transient: 0.08, lowBand: 0.12, midBand: 0.18, highBand: 0.1 }, { speechStart: false }));

    const quietLift = Math.max(...quiet.dots.map((dot) => dot.lift));
    const loudLift = Math.max(...loud.dots.map((dot) => dot.lift));

    expect(loudLift).toBeGreaterThan(quietLift * 1.35);
    expect(loudLift).toBeGreaterThan(0.19);
  });

  test('scales DOT ripple height independently from audio sensitivity', () => {
    const defaultHeight = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const tallerHeight = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    tallerHeight.setRippleHeightScale(0.7);
    defaultHeight.update(makeFrame({ rms: 0.2, smoothedRms: 0.2, transient: 0.24, lowBand: 0.16, midBand: 0.24, highBand: 0.12 }));
    tallerHeight.update(makeFrame({ rms: 0.2, smoothedRms: 0.2, transient: 0.24, lowBand: 0.16, midBand: 0.24, highBand: 0.12 }));

    const defaultTowardViewer = Math.abs(Math.min(...defaultHeight.dots.map((dot) => dot.z - dot.baseZ)));
    const tallerTowardViewer = Math.abs(Math.min(...tallerHeight.dots.map((dot) => dot.z - dot.baseZ)));

    expect(tallerTowardViewer).toBeGreaterThan(defaultTowardViewer * 1.55);
  });

  test('allows DOT lift to go far below the previous 0.5 floor', () => {
    const lowLift = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const oldFloorLift = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    lowLift.setRippleHeightScale(0.05);
    oldFloorLift.setRippleHeightScale(0.5);
    lowLift.update(makeFrame({ rms: 0.2, smoothedRms: 0.2, transient: 0.24, lowBand: 0.16, midBand: 0.24, highBand: 0.12 }));
    oldFloorLift.update(makeFrame({ rms: 0.2, smoothedRms: 0.2, transient: 0.24, lowBand: 0.16, midBand: 0.24, highBand: 0.12 }));

    const lowTowardViewer = Math.abs(Math.min(...lowLift.dots.map((dot) => dot.z - dot.baseZ)));
    const oldFloorTowardViewer = Math.abs(Math.min(...oldFloorLift.dots.map((dot) => dot.z - dot.baseZ)));

    expect(lowTowardViewer).toBeLessThan(oldFloorTowardViewer * 0.16);
  });

  test('does not lift the whole DOT grid when no ripple is active', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0, lowBand: 0.05, midBand: 0.05, highBand: 0.04 }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));

    expect(model.ripples).toHaveLength(0);
    expect(Math.max(...model.dots.map((dot) => dot.lift))).toBeLessThan(0.004);
  });

  test('starts a subtle DOT ripple from quiet nonzero sound', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({
      rms: 0.018,
      smoothedRms: 0.018,
      transient: 0.025,
      lowBand: 0.014,
      midBand: 0.018,
      highBand: 0.012,
    }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));

    expect(model.ripples.length).toBeGreaterThan(0);
  });

  test('does not resize every DOT dot from global audio when no ripple is active', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ rms: 0.01, smoothedRms: 0.01, transient: 0, lowBand: 0.01, midBand: 0.01, highBand: 0.98 }, {
      speakingIntensity: 0,
      speechStart: false,
      state: 'listening',
    }));

    expect(model.ripples).toHaveLength(0);
    expect(Math.max(...model.dots.map((dot) => dot.radius))).toBeLessThan(0.58);
  });

  test('softens DOT lift near the ceiling instead of hard-clamping dots together', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.ripples = [
      { timestamp: 100, intensity: 4.5, duration: 6000, originX: -24, originY: -16, speakerId: null },
      { timestamp: 100, intensity: 4.5, duration: 6000, originX: 0, originY: 0, speakerId: null },
      { timestamp: 100, intensity: 4.5, duration: 6000, originX: 24, originY: 16, speakerId: null },
    ];

    model.update(makeFrame({ timestamp: 100, rms: 0.2, smoothedRms: 0.2, transient: 0, lowBand: 0.18, midBand: 0.2, highBand: 0.12 }, {
      speakingIntensity: 0,
      speechStart: false,
    }));

    const highLifts = model.dots.map((dot) => dot.lift).filter((lift) => lift > 0.08);
    const roundedLifts = new Set(highLifts.map((lift) => lift.toFixed(4)));

    expect(Math.max(...highLifts)).toBeLessThan(0.36);
    expect(roundedLifts.size).toBeGreaterThanOrEqual(4);
  });

  test('varies successive ripple origins even with similar frequency content', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.04, smoothedRms: 0.04, transient: 0.22, spectralCentroid: 0.48, lowBand: 0.18, midBand: 0.32, highBand: 0.16 }));
    model.update(makeFrame({ timestamp: 420, rms: 0.04, smoothedRms: 0.04, transient: 0.22, spectralCentroid: 0.48, lowBand: 0.18, midBand: 0.32, highBand: 0.16 }));

    const firstOrigin = model.ripples[0];
    const secondOrigin = model.ripples[1];
    const originDistance = Math.hypot(secondOrigin.originX - firstOrigin.originX, secondOrigin.originY - firstOrigin.originY);

    expect(originDistance).toBeGreaterThan(8);
  });

  test('varies DOT ripple centers between separate triggers instead of only within one trigger', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const frequencyBins = Array.from({ length: 32 }, () => 0.01);

    frequencyBins[10] = 0.48;
    frequencyBins[18] = 0.32;

    model.update(makeFrame({ timestamp: 100, rms: 0.08, smoothedRms: 0.08, transient: 0.26, spectralCentroid: 0.45, lowBand: 0.12, midBand: 0.32, highBand: 0.18, frequencyBins }));
    const firstBatch = model.ripples.map((ripple) => ({ x: ripple.originX, y: ripple.originY }));

    model.update(makeFrame({ timestamp: 520, rms: 0.085, smoothedRms: 0.085, transient: 0.28, spectralCentroid: 0.47, lowBand: 0.11, midBand: 0.33, highBand: 0.2, frequencyBins }, { speechStart: true }));
    const secondBatch = model.ripples.slice(firstBatch.length).map((ripple) => ({ x: ripple.originX, y: ripple.originY }));

    const averagePoint = (points: Array<{ x: number; y: number }>): { x: number; y: number } => ({
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    });
    const firstCenter = averagePoint(firstBatch);
    const secondCenter = averagePoint(secondBatch);
    const centerTravel = Math.hypot(secondCenter.x - firstCenter.x, secondCenter.y - firstCenter.y);

    expect(secondBatch.length).toBeGreaterThan(0);
    expect(centerTravel).toBeGreaterThan(18);
  });

  test('uses changing DOT frequency levels to move ripple centers across both plane axes', () => {
    const lowWeighted = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const highWeighted = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const lowBins = Array.from({ length: 32 }, () => 0.01);
    const highBins = Array.from({ length: 32 }, () => 0.01);

    lowBins[7] = 0.54;
    lowBins[13] = 0.28;
    highBins[18] = 0.28;
    highBins[25] = 0.54;

    lowWeighted.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.26, spectralCentroid: 0.28, lowBand: 0.32, midBand: 0.18, highBand: 0.08, frequencyBins: lowBins }));
    highWeighted.update(makeFrame({ rms: 0.08, smoothedRms: 0.08, transient: 0.26, spectralCentroid: 0.76, lowBand: 0.08, midBand: 0.18, highBand: 0.32, frequencyBins: highBins }));

    const averageOrigin = (model: DotFieldModel): { x: number; y: number } => ({
      x: model.ripples.reduce((sum, ripple) => sum + ripple.originX, 0) / model.ripples.length,
      y: model.ripples.reduce((sum, ripple) => sum + ripple.originY, 0) / model.ripples.length,
    });
    const lowOrigin = averageOrigin(lowWeighted);
    const highOrigin = averageOrigin(highWeighted);

    expect(highOrigin.x).toBeGreaterThan(lowOrigin.x + 34);
    expect(Math.abs(highOrigin.y - lowOrigin.y)).toBeGreaterThan(18);
  });

  test('adds new DOT ripples without restarting existing ripple animation', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.06, smoothedRms: 0.06, transient: 0.24 }));

    const firstTimestamps = model.ripples.map((ripple) => ripple.timestamp);
    const firstOrigins = model.ripples.map((ripple) => `${ripple.originX.toFixed(3)}:${ripple.originY.toFixed(3)}`);

    model.update(makeFrame({ timestamp: 460, rms: 0.07, smoothedRms: 0.07, transient: 0.26 }, { speechStart: true }));

    expect(model.ripples.length).toBeGreaterThan(firstTimestamps.length);
    expect(model.ripples.slice(0, firstTimestamps.length).map((ripple) => ripple.timestamp)).toEqual(firstTimestamps);
    expect(model.ripples.slice(0, firstOrigins.length).map((ripple) => `${ripple.originX.toFixed(3)}:${ripple.originY.toFixed(3)}`)).toEqual(firstOrigins);
  });

  test('keeps topography ripple-free and horizontally stable', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ lowBand: 0.12, midBand: 0.7, highBand: 0.18 }), 'topography');

    const xPositions = model.dots.map((dot) => dot.x);

    expect(model.ripples).toHaveLength(0);
    expect(Math.max(...model.dots.map((dot) => dot.topographyLift))).toBeGreaterThan(0);

    model.update(makeFrame({ timestamp: 420, lowBand: 0.08, midBand: 0.2, highBand: 0.78 }, { speechStart: false }), 'topography');

    expect(model.ripples).toHaveLength(0);
    expect(model.dots.every((dot, index) => dot.x === xPositions[index])).toBe(true);
  });

  test('keeps topography baseline fixed when volume rises', () => {
    const quiet = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const loud = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    quiet.update(makeFrame({ rms: 0.02, smoothedRms: 0.02, lowBand: 0.06, midBand: 0.1, highBand: 0.04 }, { speakingIntensity: 0.1 }), 'topography');
    loud.update(makeFrame({ rms: 0.42, smoothedRms: 0.42, lowBand: 0.06, midBand: 0.1, highBand: 0.04 }, { speakingIntensity: 0.7 }), 'topography');

    expect(loud.dots.every((dot, index) => dot.y === quiet.dots[index].y)).toBe(true);
  });

  test('spreads topography spectrum through the inner band instead of a fixed center spike', () => {
    const lowModel = new DotFieldModel({ rings: 4, dotsPerRing: 18, radius: 80 });
    const highModel = new DotFieldModel({ rings: 4, dotsPerRing: 18, radius: 80 });

    lowModel.update(makeFrame({ lowBand: 0.96, midBand: 0.04, highBand: 0.02, brightness: 0.02 }), 'topography');
    highModel.update(makeFrame({ lowBand: 0.02, midBand: 0.04, highBand: 0.96, brightness: 0.86 }), 'topography');

    const lowPeak = lowModel.dots.reduce((strongest, dot) => (dot.topographyLift > strongest.topographyLift ? dot : strongest), lowModel.dots[0]);
    const highPeak = highModel.dots.reduce((strongest, dot) => (dot.topographyLift > strongest.topographyLift ? dot : strongest), highModel.dots[0]);

    const lowDistance = Math.abs(lowPeak.frequencyRatio - 0.5);
    const highDistance = Math.abs(highPeak.frequencyRatio - 0.5);

    expect(lowDistance).toBeGreaterThan(0.1);
    expect(lowDistance).toBeLessThan(0.24);
    expect(highDistance).toBeGreaterThan(lowDistance + 0.06);
    expect(highDistance).toBeLessThan(0.38);
  });

  test('keeps detailed spectrum peaks away from the absolute edges', () => {
    const model = new DotFieldModel({ rings: 3, dotsPerRing: 16, radius: 80 });
    const frequencyBins = Array.from({ length: 16 }, () => 0.01);
    frequencyBins[12] = 0.92;

    model.update(makeFrame(Object.assign({
      rms: 0.28,
      smoothedRms: 0.28,
      lowBand: 0,
      midBand: 0,
      highBand: 0,
      brightness: 0,
    }, { frequencyBins }) as Partial<DotFieldUpdate['audio']>), 'topography');

    const edgeLift = Math.max(...model.dots.filter((dot) => dot.frequencyRatio < 0.12 || dot.frequencyRatio > 0.88).map((dot) => dot.topographyLift));
    const shoulderLift = Math.max(...model.dots.filter((dot) => (dot.frequencyRatio > 0.18 && dot.frequencyRatio < 0.38) || (dot.frequencyRatio > 0.62 && dot.frequencyRatio < 0.82)).map((dot) => dot.topographyLift));

    expect(shoulderLift).toBeGreaterThan(edgeLift * 1.6);
  });

  test('keeps the middle of topography lines comparable to neighboring inner areas', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 18, radius: 80 });

    model.update(makeFrame({ rms: 0.32, smoothedRms: 0.3, lowBand: 0.62, midBand: 0.48, highBand: 0.18, brightness: 0.22 }, { speechStart: false }), 'topography');

    const centerLift = Math.max(...model.dots.filter((dot) => dot.frequencyRatio > 0.47 && dot.frequencyRatio < 0.53).map((dot) => dot.topographyLift));
    const shoulderLift = Math.max(...model.dots.filter((dot) => (dot.frequencyRatio > 0.34 && dot.frequencyRatio < 0.46) || (dot.frequencyRatio > 0.54 && dot.frequencyRatio < 0.66)).map((dot) => dot.topographyLift));
    const edgeLift = Math.max(...model.dots.filter((dot) => dot.frequencyRatio < 0.14 || dot.frequencyRatio > 0.86).map((dot) => dot.topographyLift));

    expect(centerLift).toBeGreaterThan(edgeLift * 1.25);
    expect(centerLift).toBeGreaterThan(shoulderLift * 0.74);
    expect(shoulderLift).toBeGreaterThan(centerLift * 0.74);
  });

  test('updates topography rows together instead of sending a wave backward', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.01, smoothedRms: 0.01, lowBand: 0.01, midBand: 0.01, highBand: 0.01 }, { speechStart: false }), 'topography');
    model.update(makeFrame({ timestamp: 160, rms: 0.36, smoothedRms: 0.34, lowBand: 0.58, midBand: 0.52, highBand: 0.36 }, { speechStart: false }), 'topography');

    const backRowLift = Math.max(...model.rows[0].map((dot) => dot.topographyLift));
    const frontRowLift = Math.max(...model.rows[model.rows.length - 1].map((dot) => dot.topographyLift));

    expect(backRowLift).toBeGreaterThan(frontRowLift * 0.58);
  });

  test('adds new topography hits without clearing lingering line energy', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.3, smoothedRms: 0.3, lowBand: 0.94, midBand: 0.04, highBand: 0.02, brightness: 0.02 }, { speechStart: false }), 'topography');

    const centerBefore = Math.max(...model.dots.filter((dot) => dot.frequencyRatio > 0.38 && dot.frequencyRatio < 0.62).map((dot) => dot.topographyLift));
    const outerBefore = Math.max(...model.dots.filter((dot) => dot.frequencyRatio < 0.24 || dot.frequencyRatio > 0.76).map((dot) => dot.topographyLift));

    model.update(makeFrame({ timestamp: 260, rms: 0.34, smoothedRms: 0.32, lowBand: 0.02, midBand: 0.06, highBand: 0.92, brightness: 0.82 }, { speechStart: false }), 'topography');

    const centerAfter = Math.max(...model.dots.filter((dot) => dot.frequencyRatio > 0.38 && dot.frequencyRatio < 0.62).map((dot) => dot.topographyLift));
    const outerAfter = Math.max(...model.dots.filter((dot) => dot.frequencyRatio < 0.24 || dot.frequencyRatio > 0.76).map((dot) => dot.topographyLift));

    expect(centerAfter).toBeGreaterThan(centerBefore * 0.92);
    expect(outerAfter).toBeGreaterThan(outerBefore + 0.018);
  });

  test('lets near-max topography energy release softly across most of a row cycle', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    for (const dot of model.dots) {
      if (dot.frequencyRatio > 0.36 && dot.frequencyRatio < 0.64) {
        dot.topographyLift = 0.94;
      }
    }

    const beforeSilence = Math.max(...model.dots.map((dot) => dot.topographyLift));

    for (let index = 1; index <= 300; index += 1) {
      model.update(makeFrame({ timestamp: index * 16, rms: 0, smoothedRms: 0.01, transient: 0, lowBand: 0, midBand: 0, highBand: 0, brightness: 0 }, {
        state: 'idle',
        confidence: 0.1,
        speakingIntensity: 0,
        speechStart: false,
      }), 'topography');
    }

    const afterSilence = Math.max(...model.dots.map((dot) => dot.topographyLift));

    expect(afterSilence).toBeGreaterThan(beforeSilence * 0.52);
  });

  test('cycles topography row focus over time and loops back to the first lines', () => {
    const start = new DotFieldModel({ rings: 5, dotsPerRing: 10, radius: 80 });
    const middle = new DotFieldModel({ rings: 5, dotsPerRing: 10, radius: 80 });
    const loop = new DotFieldModel({ rings: 5, dotsPerRing: 10, radius: 80 });
    const strongestRow = (model: DotFieldModel): number => model.rows
      .map((row) => Math.max(...row.map((dot) => dot.topographyLift)))
      .reduce((strongestIndex, lift, index, rowLifts) => (lift > rowLifts[strongestIndex] ? index : strongestIndex), 0);

    start.update(makeFrame({ timestamp: 0, rms: 0.34, smoothedRms: 0.34, lowBand: 0.2, midBand: 0.72, highBand: 0.2 }, { speechStart: false }), 'topography');
    middle.update(makeFrame({ timestamp: 3200, rms: 0.34, smoothedRms: 0.34, lowBand: 0.2, midBand: 0.72, highBand: 0.2 }, { speechStart: false }), 'topography');
    loop.update(makeFrame({ timestamp: 6400, rms: 0.34, smoothedRms: 0.34, lowBand: 0.2, midBand: 0.72, highBand: 0.2 }, { speechStart: false }), 'topography');

    const startRow = strongestRow(start);
    const middleRow = strongestRow(middle);
    const loopRow = strongestRow(loop);

    expect(Math.abs(startRow - middleRow)).toBeGreaterThan(2);
    expect(Math.abs(startRow - loopRow)).toBeLessThanOrEqual(1);
  });

  test('lets focused topography rows keep different frequency shapes', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 16, radius: 80 });
    const strongestDistanceFromCenter = (rowIndex: number): number => {
      const row = model.rows[rowIndex];
      const strongestDot = row.reduce((strongest, dot) => (dot.topographyLift > strongest.topographyLift ? dot : strongest), row[0]);

      return Math.abs(strongestDot.frequencyRatio - 0.5);
    };

    model.update(makeFrame({ timestamp: 0, rms: 0.36, smoothedRms: 0.34, lowBand: 0.88, midBand: 0.08, highBand: 0.02, brightness: 0.08 }, { speechStart: false }), 'topography');

    for (let index = 0; index < 8; index += 1) {
      model.update(makeFrame({ timestamp: 3200 + index * 90, rms: 0.36, smoothedRms: 0.34, lowBand: 0.02, midBand: 0.08, highBand: 0.88, brightness: 0.86 }, { speechStart: false }), 'topography');
    }

    const firstRowDistance = strongestDistanceFromCenter(0);
    const middleRowDistance = strongestDistanceFromCenter(Math.floor(model.rows.length / 2));

    expect(firstRowDistance).toBeLessThan(0.24);
    expect(middleRowDistance).toBeGreaterThan(firstRowDistance + 0.1);
  });

  test('uses detailed spectrum bins to shape topography beyond broad rounded bands', () => {
    const model = new DotFieldModel({ rings: 3, dotsPerRing: 16, radius: 80 });
    const frequencyBins = Array.from({ length: 16 }, () => 0.01);
    frequencyBins[2] = 0.92;
    frequencyBins[7] = 0.24;
    frequencyBins[12] = 0.76;

    model.update(makeFrame(Object.assign({
      rms: 0.28,
      smoothedRms: 0.28,
      lowBand: 0,
      midBand: 0,
      highBand: 0,
      brightness: 0,
    }, { frequencyBins }) as Partial<DotFieldUpdate['audio']>), 'topography');

    const activeRow = model.rows.reduce((strongest, row) => {
      const strongestLift = Math.max(...strongest.map((dot) => dot.topographyLift));
      const rowLift = Math.max(...row.map((dot) => dot.topographyLift));

      return rowLift > strongestLift ? row : strongest;
    }, model.rows[0]);
    const lifts = activeRow.map((dot) => dot.topographyLift);
    const localPeakCount = lifts.filter((lift, index) => (
      index > 0
      && index < lifts.length - 1
      && lift > lifts[index - 1] + 0.004
      && lift > lifts[index + 1] + 0.004
    )).length;

    expect(localPeakCount).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lifts) - Math.min(...lifts)).toBeGreaterThan(0.018);
  });

  test('keeps DOT ripple flow alive after abrupt silence', () => {
    const abrupt = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });
    const faded = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    abrupt.update(makeFrame());
    faded.update(makeFrame());

    abrupt.update(makeFrame({ timestamp: 132, rms: 0, smoothedRms: 0.01, transient: 0, brightness: 0, lowBand: 0, midBand: 0, highBand: 0 }, {
      state: 'idle',
      confidence: 0.2,
      speakingIntensity: 0,
      speechStart: false,
      speechEnd: true,
    }));
    faded.update(makeFrame({ timestamp: 132, rms: 0.21, smoothedRms: 0.24, transient: 0.02, brightness: 0.35, lowBand: 0.16, midBand: 0.2, highBand: 0.08 }, {
      speakingIntensity: 0.38,
      speechStart: false,
    }));

    const abruptLift = Math.max(...abrupt.dots.map((dot) => dot.lift));
    const fadedLift = Math.max(...faded.dots.map((dot) => dot.lift));

    expect(fadedLift).toBeGreaterThan(abruptLift * 0.75);
    expect(abrupt.ripples[0].duration).toBeCloseTo(faded.ripples[0].duration, -2);
  });

  test('eases DOT lift down over the first silence frames instead of snapping flat', () => {
    const model = new DotFieldModel({ rings: 5, dotsPerRing: 14, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.34, smoothedRms: 0.34, transient: 0.5, lowBand: 0.24, midBand: 0.44, highBand: 0.2 }));
    model.update(makeFrame({ timestamp: 220, rms: 0.3, smoothedRms: 0.32, transient: 0.08, lowBand: 0.2, midBand: 0.38, highBand: 0.16 }, {
      speechStart: false,
    }));

    const liftedDot = model.dots.reduce((strongest, dot) => (Math.abs(dot.lift) > Math.abs(strongest.lift) ? dot : strongest), model.dots[0]);
    const beforeSilence = Math.abs(liftedDot.lift);

    model.update(makeFrame({ timestamp: 244, rms: 0, smoothedRms: 0.01, transient: 0, brightness: 0, lowBand: 0, midBand: 0, highBand: 0 }, {
      state: 'idle',
      confidence: 0.2,
      speakingIntensity: 0,
      speechStart: false,
      speechEnd: true,
    }));

    const firstSilenceLift = Math.abs(model.dots.find((dot) => dot.id === liftedDot.id)?.lift ?? 0);

    expect(firstSilenceLift).toBeGreaterThan(beforeSilence * 0.55);
    expect(firstSilenceLift).toBeLessThan(beforeSilence * 1.08);
  });

  test('does not abruptly flatten DOT lift after abrupt silence', () => {
    const model = new DotFieldModel({ rings: 4, dotsPerRing: 10, radius: 80 });

    model.update(makeFrame({ timestamp: 100, rms: 0.3, smoothedRms: 0.3, transient: 0.5, lowBand: 0.2, midBand: 0.42, highBand: 0.18 }));
    const beforeSilence = Math.max(...model.dots.map((dot) => dot.lift));

    for (let index = 1; index <= 8; index += 1) {
      model.update(makeFrame({ timestamp: 100 + index * 24, rms: 0, smoothedRms: 0.01, transient: 0, brightness: 0, lowBand: 0, midBand: 0, highBand: 0 }, {
        state: 'idle',
        confidence: 0.2,
        speakingIntensity: 0,
        speechStart: false,
        speechEnd: true,
      }));
    }

    const afterSilence = Math.max(...model.dots.map((dot) => dot.lift));

    expect(afterSilence).toBeGreaterThan(beforeSilence * 20);
  });
});