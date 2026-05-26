import { clamp01, smoothValue } from '../audio/math';
import type { AudioFeatures } from '../types/audio';
import type { SpeechActivityFrame } from '../types/speech';
import type { SpeakerFrame } from '../types/speakers';
import { visualHeightDisplacement, visualPlaneDimensions } from './VisualGeometry';
import { overlapDelayRange, rippleHeightRange, rippleSpeedRange, tailDampingRange } from './visualControlDefaults';

export type DotFieldOptions = {
  rings: number;
  dotsPerRing: number;
  radius: number;
};

export type DotState = {
  id: string;
  baseX: number;
  baseY: number;
  baseZ: number;
  frequencyRatio: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  angle: number;
  ringIndex: number;
  depth: number;
  speakerBand: string;
  densityWeight: number;
  lift: number;
  topographyLift: number;
  opacity: number;
  brightness: number;
};

export type RippleState = {
  timestamp: number;
  intensity: number;
  duration: number;
  originX: number;
  originY: number;
  speakerId: string | null;
};

export type DotFieldUpdate = {
  audio: AudioFeatures;
  speech: SpeechActivityFrame;
  speaker: SpeakerFrame;
};

export type ModelMode = 'depthPlane' | 'topography';

type RippleEmitter = {
  frequencyRatio: number;
  planeYRatio: number;
  energy: number;
  delay: number;
};

type RippleEmitterCandidate = Omit<RippleEmitter, 'delay'>;

export class DotFieldModel {
  readonly dots: DotState[];
  readonly rows: DotState[][];
  readonly options: DotFieldOptions;
  ripples: RippleState[] = [];
  private rippleHeightScale: number = rippleHeightRange.default;
  private soundMemory = 0;
  private previousSoundPresence = 0;
  private rippleSerial = 0;
  private rippleSpeed: number = rippleSpeedRange.default;
  private overlapDelayMs: number = overlapDelayRange.default;
  private tailDamping: number = tailDampingRange.default;

  constructor(options: DotFieldOptions) {
    this.options = options;
    this.dots = this.generateDots(options);
    this.rows = this.groupRows(this.dots);
  }

  setRippleHeightScale(scale: number): void {
    this.rippleHeightScale = Math.min(1.2, Math.max(0.02, scale));
  }

  setFlowControls(speed: number, overlapDelayMs: number, tailDamping: number): void {
    this.rippleSpeed = Math.min(rippleSpeedRange.max, Math.max(rippleSpeedRange.min, speed));
    this.overlapDelayMs = Math.min(overlapDelayRange.max, Math.max(overlapDelayRange.min, overlapDelayMs));
    this.tailDamping = Math.min(tailDampingRange.max, Math.max(tailDampingRange.min, tailDamping));
  }

  update(frame: DotFieldUpdate, mode: ModelMode = 'depthPlane'): void {
    const activeSpeaker = frame.speaker.activeSpeakerId;
    const activeSpeakerState = frame.speaker.speakers.find((speaker) => speaker.speakerId === activeSpeaker);
    const spectrumPresence = this.spectrumPresence(frame.audio.frequencyBins);
    const rawSoundPresence = clamp01(frame.audio.rms * 9 + frame.audio.transient * 0.55 + frame.audio.midBand * 1.2 + spectrumPresence * 1.4);
    const risingEnergy = clamp01(rawSoundPresence - this.previousSoundPresence);
    const releaseEnergy = clamp01(this.previousSoundPresence - rawSoundPresence);
    const abruptRelease = releaseEnergy > 0.18 && rawSoundPresence < 0.12;
    const fadingRelease = releaseEnergy > 0.02 && rawSoundPresence >= 0.12;
    const memoryRate = rawSoundPresence > this.soundMemory ? 0.34 : abruptRelease ? 0.58 : fadingRelease ? 0.045 : 0.09;

    this.soundMemory = smoothValue(this.soundMemory, rawSoundPresence, memoryRate);

    if (mode === 'topography') {
      this.ripples = [];
    }

    const hasSubtleFrequencyDetail = spectrumPresence > 0.004;
    const hasSubtleBroadInput = frame.audio.rms > 0.012 || frame.audio.lowBand > 0.012 || frame.audio.midBand > 0.012;
    const subtleSoundStart = rawSoundPresence > 0.018 && rawSoundPresence < 0.38 && risingEnergy > 0.003 && (hasSubtleFrequencyDetail || hasSubtleBroadInput);
    const shouldStartRipple = mode === 'depthPlane' && (frame.speech.speechStart || subtleSoundStart || (risingEnergy > 0.04 && frame.audio.transient > 0.16) || (risingEnergy > 0.07 && frame.audio.midBand > 0.24));

    if (shouldStartRipple) {
      this.rippleSerial += 1;

      const driftPhase = this.rippleSerial * 2.399963 + frame.audio.timestamp * 0.00053 + frame.audio.spectralCentroid * Math.PI * 2;
      const volumeSpread = (0.18 + rawSoundPresence * 0.68) * this.options.radius;
      const frequencySkewX = (frame.audio.midBand - frame.audio.lowBand) * this.options.radius * 0.28;
      const frequencySkewY = (frame.audio.highBand - frame.audio.lowBand) * this.options.radius * 0.26;
      const volumeLevel = clamp01(frame.audio.rms * 2.6 + frame.audio.smoothedRms * 1.15);
      const emitters = this.rippleEmittersFor(frame.audio, volumeLevel);
      const planeDimensions = visualPlaneDimensions(this.options.radius);
      const spectralMotion = this.spectralPlaneMotion(frame.audio);
      const triggerPhase = this.rippleSerial * 1.914 + frame.audio.timestamp * 0.0017 + spectralMotion.phase;
      const triggerRange = this.options.radius * (0.06 + rawSoundPresence * 0.14 + spectralMotion.spread * 0.12);
      const triggerDriftAmount = this.rippleSerial <= 1 ? 0.18 : 1;
      const triggerOffsetX = (spectralMotion.x * planeDimensions.width * 0.025 + Math.cos(triggerPhase) * triggerRange) * triggerDriftAmount;
      const triggerOffsetY = (spectralMotion.y * planeDimensions.height * 0.04 + Math.sin(triggerPhase * 0.83) * triggerRange * 0.82) * triggerDriftAmount;

      for (let index = 0; index < emitters.length; index += 1) {
        const emitter = emitters[index];
        const phase = driftPhase + index * 1.37 + emitter.frequencyRatio * Math.PI * 1.6;
        const frequencyOrigin = this.frequencyOriginVector(emitter.frequencyRatio, emitter.planeYRatio, phase);
        const originX = frequencyOrigin.x * planeDimensions.width * 0.5 + triggerOffsetX + Math.cos(phase) * volumeSpread * 0.16 + frequencySkewX * 0.16;
        const originY = frequencyOrigin.y * planeDimensions.height * 0.5 + triggerOffsetY + Math.sin(phase * 1.13) * volumeSpread * 0.16 + frequencySkewY * 0.16;
        const intensity = Math.max(
          0.14,
          (0.18 + volumeLevel * 1.42) * (0.34 + Math.pow(emitter.energy, 1.35) * 1.28)
            + frame.audio.transient * (0.08 + emitter.energy * 0.28)
            + frame.speech.speakingIntensity * 0.06,
        );

        this.ripples.push({
          timestamp: frame.speech.timestamp + emitter.delay,
          intensity,
          duration: 4200 + rawSoundPresence * 3600 + emitter.energy * 1400,
          originX: this.clampToPlane(originX, this.options.radius * 1.05),
          originY: this.clampToPlane(originY, this.options.radius * 0.64),
          speakerId: frame.speaker.activeSpeakerId,
        });
      }
    }

    this.ripples = this.ripples.filter((ripple) => frame.audio.timestamp - ripple.timestamp < ripple.duration).slice(-20);

    const soundPresence = clamp01(rawSoundPresence * 0.55 + this.soundMemory * 0.45);
    const currentSoundPressure = this.soundPressureFor(frame.audio, rawSoundPresence, spectrumPresence);
    const speechPresence = clamp01(frame.speech.speakingIntensity + (activeSpeakerState?.voiceEnergy ?? 0));
    const releaseRate = abruptRelease ? 0.92 : fadingRelease ? 0.026 : 0.052;

    for (const dot of this.dots) {
      let rippleInfluence = 0;
      if (mode === 'depthPlane') {
        for (const ripple of this.ripples) {
          rippleInfluence += this.rippleAt(frame.audio.timestamp, ripple, dot.baseX, dot.baseY, currentSoundPressure);
        }
      }
      const hasSpeakerLayer = activeSpeaker !== null;
      const near = 1 - dot.depth;
      const speakerLift = hasSpeakerLayer ? speechPresence * 0.3 : 0;
      const topographyAudio = frame.audio;
      const frequencyEnergy = this.frequencyEnergyAt(dot.frequencyRatio, topographyAudio);
      const heightLevel = clamp01(topographyAudio.smoothedRms * 1.45 + topographyAudio.rms * 0.55 + frame.speech.speakingIntensity * 0.12);
      const topographyRiseRate = 0.074 + topographyAudio.transient * 0.04 + topographyAudio.rhythm * 0.016;
      const topographyReleaseRate = abruptRelease ? 0.006 : fadingRelease ? 0.004 : 0.0045;
      const rowFocus = this.topographyRowFocus(frame.audio.timestamp, dot.ringIndex);
      const targetLift = mode === 'depthPlane' ? this.signedSoftLimit(rippleInfluence * 1.58) : 0;
      const lift = smoothValue(dot.lift, targetLift, targetLift > dot.lift ? 0.34 + frame.audio.transient * 0.18 : releaseRate);
      const topographyTarget = mode === 'topography'
        ? this.softLimit(frequencyEnergy * rowFocus * (0.58 + heightLevel * 1.18 + topographyAudio.transient * 0.34) * (0.88 + near * 0.12))
        : 0;
      const topographyLift = mode === 'topography'
        ? this.easeTopographyLift(dot.topographyLift, topographyTarget, topographyRiseRate, topographyReleaseRate)
        : smoothValue(dot.topographyLift, 0, 0.045);
      const visualLift = lift * this.rippleHeightScale;
      const heightOffset = visualHeightDisplacement(visualLift * (78 + near * 34), this.options.radius);
      dot.x = dot.baseX;
      dot.y = dot.baseY + heightOffset.y;
      dot.z = dot.baseZ + heightOffset.z;
      dot.lift = lift;
      dot.topographyLift = topographyLift;
      dot.brightness = smoothValue(dot.brightness, clamp01(frame.audio.brightness * 0.55 + Math.abs(rippleInfluence) * 0.58 + speakerLift), 0.16);
      dot.opacity = smoothValue(dot.opacity, clamp01(soundPresence * 0.06 + Math.abs(lift) * 0.26 + speakerLift * 0.08), targetLift > dot.lift ? 0.09 : releaseRate * 0.6);
      dot.radius = Math.max(0.36, 0.52 + Math.max(0, visualLift) * 1.28 + Math.min(0, visualLift) * 0.18);
    }

    this.previousSoundPresence = rawSoundPresence;
  }

  private generateDots(options: DotFieldOptions): DotState[] {
    const dots: DotState[] = [];
    const rows = options.rings * 2 + 1;
    const columns = options.dotsPerRing * 2;
    const planeDimensions = visualPlaneDimensions(options.radius);

    for (let row = 0; row < rows; row += 1) {
      const rowRatio = rows === 1 ? 0 : row / (rows - 1);
      const baseY = (rowRatio - 0.5) * planeDimensions.height;
      const baseZ = (1 - rowRatio) * planeDimensions.depth;

      for (let column = 0; column < columns; column += 1) {
        const columnRatio = columns === 1 ? 0 : column / (columns - 1);
        const baseX = (columnRatio - 0.5) * planeDimensions.width;
        const angle = Math.atan2(baseY, baseX);

        dots.push({
          id: `${row}-${column}`,
          baseX,
          baseY,
          baseZ,
          frequencyRatio: columnRatio,
          x: baseX,
          y: baseY,
          z: baseZ,
          radius: 0.65,
          angle,
          ringIndex: row,
          depth: 1 - rowRatio,
          speakerBand: this.speakerBandForRow(rowRatio),
          densityWeight: 1 - Math.abs(columnRatio - 0.5) * 0.22,
          lift: 0,
          topographyLift: 0,
          opacity: 0,
          brightness: 0,
        });
      }
    }

    return dots;
  }

  private speakerBandForRow(rowRatio: number): string {
    if (rowRatio < 0.34) {
      return 'speaker-a';
    }

    if (rowRatio < 0.68) {
      return 'speaker-b';
    }

    return 'speaker-c';
  }

  private rippleAt(now: number, ripple: RippleState, x: number, y: number, currentSoundPressure: number): number {
    const age = now - ripple.timestamp;

    if (age < 0) {
      return 0;
    }

    const distance = Math.hypot(x - ripple.originX, (y - ripple.originY) * 1.18) / this.options.radius;
    const width = 0.037 + ripple.intensity * 0.034;
    const sourceRadius = 0.038 + currentSoundPressure * 0.018;
    const audibleSourcePressure = currentSoundPressure > 0.01 ? Math.max(currentSoundPressure, 0.18) : 0;
    const sourceArea = Math.exp(-(distance * distance) / (2 * sourceRadius * sourceRadius));
    const waveFor = (waveAge: number, intensityScale: number): number => {
      if (waveAge < 0) {
        return 0;
      }

      const wavePosition = waveAge / (1280 / this.rippleSpeed) + this.smoothStep(0, 210, waveAge) * 0.019 * this.rippleSpeed;
      const bend = Math.sin((x - ripple.originX) * 0.027 + waveAge * 0.0015) * 0.03;
      const delta = Math.abs(distance - wavePosition + bend);
      const troughDelta = Math.abs(distance - (wavePosition - width * 0.68) + bend * 0.6);
      const underDelta = Math.abs(distance - (wavePosition + width * 0.82) + bend * 0.45);
      const envelope = Math.pow(clamp01(1 - waveAge / ripple.duration), 1.25 + this.tailDamping * 0.35);
      const waveAttack = 0.18 + this.smoothStep(8, 220, waveAge) * 0.82;
      const peak = clamp01(1 - delta / width);
      const trough = clamp01(1 - troughDelta / (width * 0.92));
      const under = clamp01(1 - underDelta / (width * 1.06));
      const sourceAttack = 0.04 + this.smoothStep(0, 180, waveAge) * 0.96;
      const sourceFade = 1 - this.smoothStep(104, 230, waveAge);
      const sourcePressure = Math.pow(sourceArea, 1.55) * audibleSourcePressure * sourceAttack * sourceFade * ripple.intensity * 4.08 * intensityScale;
      const troughDamping = 1 - Math.min(1, sourceArea * sourceAttack * sourceFade * 0.96);
      const expansionDamping = 1 / (1 + Math.max(0, wavePosition - 0.82) * (2.9 + this.tailDamping * 0.9));
      const travellingWave = (
        Math.pow(peak, 3.8)
          - Math.pow(trough, 1.56) * 0.58 * troughDamping
          - Math.pow(under, 1.64) * 0.34
      ) * envelope * expansionDamping * ripple.intensity * 2.09 * waveAttack * intensityScale;

      return travellingWave + sourcePressure;
    };

    return waveFor(age, 1) + waveFor(age - this.overlapDelayMs, 0.27);
  }

  private dominantFrequency(audio: AudioFeatures): number {
    const totalEnergy = audio.lowBand + audio.midBand + audio.highBand;

    if (totalEnergy <= 0.001) {
      return audio.spectralCentroid;
    }

    const bandCenter = (audio.lowBand * 0.16 + audio.midBand * 0.5 + audio.highBand * 0.84) / totalEnergy;

    return clamp01(bandCenter * 0.72 + audio.spectralCentroid * 0.28);
  }

  private rippleEmittersFor(audio: AudioFeatures, volumeLevel: number): RippleEmitter[] {
    const candidates = this.frequencyPeakCandidates(audio);
    const emitters: RippleEmitterCandidate[] = [];

    for (const candidate of candidates) {
      if (emitters.every((emitter) => Math.abs(emitter.frequencyRatio - candidate.frequencyRatio) > 0.055)) {
        emitters.push(candidate);
      }

      if (emitters.length === 5) {
        break;
      }
    }

    return this.withEmitterDelays(emitters, volumeLevel);
  }

  private withEmitterDelays(emitters: RippleEmitterCandidate[], volumeLevel: number): RippleEmitter[] {
    if (emitters.length === 0) {
      return [];
    }

    const delayedEmitters = emitters
      .sort((left, right) => left.frequencyRatio - right.frequencyRatio)
      .map((emitter, index) => ({
        ...emitter,
        energy: clamp01(emitter.energy * 0.95 + volumeLevel * 0.05),
        delay: index * (24 + volumeLevel * 14) + emitter.frequencyRatio * 16,
      }));
    const firstDelay = Math.min(...delayedEmitters.map((emitter) => emitter.delay));

    return delayedEmitters.map((emitter) => ({
      ...emitter,
      delay: emitter.delay - firstDelay,
    }));
  }

  private frequencyPeakCandidates(audio: AudioFeatures): RippleEmitterCandidate[] {
    const candidates: RippleEmitterCandidate[] = [];
    const averageBinEnergy = audio.frequencyBins.length === 0
      ? 0
      : audio.frequencyBins.reduce((sum, value) => sum + clamp01(value), 0) / audio.frequencyBins.length;
    const binThreshold = Math.max(0.004, averageBinEnergy * 1.35, audio.noiseFloor * 0.04);

    for (let index = 0; index < audio.frequencyBins.length; index += 1) {
      const energy = clamp01(audio.frequencyBins[index] ?? 0);

      if (energy <= binThreshold) {
        continue;
      }

      const previous = clamp01(audio.frequencyBins[Math.max(0, index - 1)] ?? 0);
      const next = clamp01(audio.frequencyBins[Math.min(audio.frequencyBins.length - 1, index + 1)] ?? 0);
      const prominence = Math.max(0, energy - Math.max(previous, next) * 0.62 - averageBinEnergy * 0.24);
      const frequencyRatio = audio.frequencyBins.length <= 1 ? audio.spectralCentroid : index / (audio.frequencyBins.length - 1);
      const harmonicY = Math.sin((frequencyRatio * 1.75 + audio.spectralCentroid * 0.35) * Math.PI * 2) * 0.56;
      const energyY = (energy - averageBinEnergy) * 1.35;
      const bandY = (audio.highBand - audio.lowBand) * 0.24;

      candidates.push({
        frequencyRatio: clamp01(frequencyRatio),
        planeYRatio: this.clampSigned(harmonicY + energyY + bandY),
        energy: clamp01(energy * 0.72 + prominence * 0.55),
      });
    }

    if (candidates.length === 0) {
      candidates.push(
        { frequencyRatio: 0.18, planeYRatio: 0.45, energy: audio.lowBand },
        { frequencyRatio: this.dominantFrequency(audio), planeYRatio: this.clampSigned((audio.midBand - (audio.lowBand + audio.highBand) * 0.5) * 1.2), energy: Math.max(audio.midBand, audio.smoothedRms * 0.42) },
        { frequencyRatio: 0.5, planeYRatio: -0.06 + (audio.highBand - audio.lowBand) * 0.22, energy: audio.midBand },
        { frequencyRatio: 0.82, planeYRatio: -0.48, energy: audio.highBand },
      );
    }

    return candidates.sort((left, right) => right.energy - left.energy);
  }

  private frequencyOriginVector(frequencyRatio: number, planeYRatio: number, phase: number): { x: number; y: number } {
    const centered = clamp01(frequencyRatio) * 2 - 1;
    const horizontal = Math.sign(centered) * Math.pow(Math.abs(centered), 0.74) * 0.38;
    const randomDrift = Math.sin(phase * 0.73) * 0.04;
    const vertical = planeYRatio * 0.12 + centered * 0.37 + Math.cos(phase * 0.91) * (0.035 + Math.abs(centered) * 0.025);

    return {
      x: this.clampSigned(horizontal + randomDrift),
      y: this.clampSigned(vertical),
    };
  }

  private spectrumPresence(bins: number[]): number {
    if (bins.length === 0) {
      return 0;
    }

    let maxEnergy = 0;
    let energySum = 0;

    for (const value of bins) {
      const energy = clamp01(value);

      maxEnergy = Math.max(maxEnergy, energy);
      energySum += energy;
    }

    return clamp01(maxEnergy * 0.82 + (energySum / bins.length) * 0.18);
  }

  private soundPressureFor(audio: AudioFeatures, rawSoundPresence: number, spectrumPresence: number): number {
    return clamp01(
      rawSoundPresence * 0.62
        + audio.smoothedRms * 1.25
        + audio.rms * 0.85
        + spectrumPresence * 0.42,
    );
  }

  private spectralPlaneMotion(audio: AudioFeatures): { x: number; y: number; spread: number; phase: number } {
    if (audio.frequencyBins.length === 0) {
      return { x: 0, y: 0, spread: 0, phase: audio.spectralCentroid * Math.PI * 2 };
    }

    let energyTotal = 0;
    let weightedX = 0;
    let weightedY = 0;
    let weightedSpread = 0;
    let phaseSeed = 0;

    for (let index = 0; index < audio.frequencyBins.length; index += 1) {
      const energy = clamp01(audio.frequencyBins[index] ?? 0);
      const ratio = audio.frequencyBins.length <= 1 ? 0.5 : index / (audio.frequencyBins.length - 1);
      const centered = ratio * 2 - 1;
      const vertical = Math.sin((ratio * 2.15 + audio.spectralCentroid * 0.27) * Math.PI * 2);

      energyTotal += energy;
      weightedX += centered * energy;
      weightedY += vertical * energy;
      weightedSpread += Math.abs(centered) * energy;
      phaseSeed += Math.sin((index + 1) * 1.618) * energy;
    }

    if (energyTotal <= 0.0001) {
      return { x: 0, y: 0, spread: 0, phase: audio.spectralCentroid * Math.PI * 2 };
    }

    return {
      x: this.clampSigned(weightedX / energyTotal),
      y: this.clampSigned(weightedY / energyTotal),
      spread: clamp01(weightedSpread / energyTotal),
      phase: phaseSeed * Math.PI * 2 + audio.spectralCentroid * Math.PI,
    };
  }

  private frequencyEnergyAt(frequencyRatio: number, audio: AudioFeatures): number {
    const spectrumRatio = Math.abs(clamp01(frequencyRatio) - 0.5) * 2;
    const bandWindow = this.topographyBandWindow(spectrumRatio);
    const low = audio.lowBand * (this.bellCurve(spectrumRatio, 0.2, 0.32) + this.bellCurve(spectrumRatio, 0.36, 0.26) * 0.18);
    const mid = audio.midBand * this.bellCurve(spectrumRatio, 0.38, 0.3);
    const high = audio.highBand * (this.bellCurve(spectrumRatio, 0.58, 0.22) + this.bellCurve(spectrumRatio, 0.66, 0.22) * 0.12);
    const brightness = audio.brightness * this.bellCurve(spectrumRatio, 0.58, 0.24) * 0.18;
    const spectrum = this.spectrumEnergyAt(frequencyRatio, audio.frequencyBins);
    const broadEnergy = low + mid + high + brightness;
    const volumeScale = 0.68 + audio.smoothedRms * 0.92 + audio.transient * 0.26;

    return this.softLimit((broadEnergy * 0.82 + spectrum * 1.16) * volumeScale * bandWindow);
  }

  private spectrumEnergyAt(frequencyRatio: number, bins: number[]): number {
    if (bins.length === 0) {
      return 0;
    }

    const spectrumRatio = Math.abs(clamp01(frequencyRatio) - 0.5) * 2;
    const sampleRatio = clamp01((spectrumRatio - 0.22) / 0.42);
    const position = sampleRatio * (bins.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(bins.length - 1, lowerIndex + 1);
    const blend = position - lowerIndex;
    const lower = clamp01(bins[lowerIndex] ?? 0);
    const upper = clamp01(bins[upperIndex] ?? lower);
    const interpolated = lower + (upper - lower) * blend;
    const previous = clamp01(bins[Math.max(0, lowerIndex - 1)] ?? lower);
    const next = clamp01(bins[Math.min(bins.length - 1, upperIndex + 1)] ?? upper);
    const neighborhood = (previous + lower + upper + next) / 4;

    return clamp01(interpolated * 0.74 + neighborhood * 0.26);
  }

  private bellCurve(value: number, center: number, width: number): number {
    const distance = (value - center) / width;

    return Math.exp(-distance * distance);
  }

  private softLimit(value: number): number {
    return clamp01(1 - Math.exp(-Math.max(0, value)));
  }

  private signedSoftLimit(value: number): number {
    if (value < 0) {
      return -this.softLimit(Math.abs(value));
    }

    return this.softLimit(value);
  }

  private topographyBandWindow(spectrumRatio: number): number {
    const edgeFade = 1 - this.smoothStep(0.72, 0.96, spectrumRatio) * 0.92;

    return edgeFade;
  }

  private topographyRowFocus(timestamp: number, rowIndex: number): number {
    const rowCount = this.rows.length;
    const cycleDuration = 6400;
    const focusPosition = ((timestamp % cycleDuration) / cycleDuration) * rowCount;
    const directDistance = Math.abs(rowIndex - focusPosition);
    const loopDistance = Math.min(directDistance, rowCount - directDistance);
    const focusWidth = Math.max(0.9, rowCount * 0.08);
    const focus = Math.exp(-(loopDistance * loopDistance) / (2 * focusWidth * focusWidth));

    return focus;
  }

  private smoothStep(edge0: number, edge1: number, value: number): number {
    const amount = clamp01((value - edge0) / (edge1 - edge0));

    return amount * amount * (3 - 2 * amount);
  }

  private easeTopographyLift(current: number, target: number, riseRate: number, releaseRate: number): number {
    if (target > current) {
      const additiveRise = target * riseRate * (1 - current * 0.42);
      const easedCatchup = (target - current) * riseRate * 0.28;

      return clamp01(current + additiveRise + easedCatchup);
    }

    const releaseEase = releaseRate * (0.025 + Math.pow(1 - current, 2.2) * 0.3);

    return smoothValue(current, target, releaseEase);
  }

  private clampToPlane(value: number, limit: number): number {
    return Math.max(-limit, Math.min(limit, value));
  }

  private clampSigned(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }

  private groupRows(dots: DotState[]): DotState[][] {
    const rows: DotState[][] = [];

    for (const dot of dots) {
      rows[dot.ringIndex] ??= [];
      rows[dot.ringIndex].push(dot);
    }

    return rows;
  }
}