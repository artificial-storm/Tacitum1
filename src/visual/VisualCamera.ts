export type VisualCameraState = {
  offsetX: number;
  offsetY: number;
  pitch: number;
  yaw: number;
  zoom: number;
};

export type VisualCameraMotionMode = 'fixed' | 'auto';

export type VisualCameraMotionInput = {
  energy: number;
  transient: number;
  brightness: number;
  lowBand: number;
  midBand: number;
  highBand: number;
};

export type VisualCameraPoint = {
  x: number;
  y: number;
  z: number;
};

export type ProjectedVisualPoint = {
  x: number;
  y: number;
  z: number;
  depthScale: number;
};

type AutoMotionLayer = {
  currentYaw: number;
  currentPitch: number;
  currentZoom: number;
  fromYaw: number;
  fromPitch: number;
  fromZoom: number;
  targetYaw: number;
  targetPitch: number;
  targetZoom: number;
  startedAt: number;
  durationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  yawAmplitude: number;
  pitchAmplitude: number;
  zoomAmplitude: number;
};

const defaultMotionInput: VisualCameraMotionInput = {
  energy: 0,
  transient: 0,
  brightness: 0,
  lowBand: 0,
  midBand: 0,
  highBand: 0,
};

export class VisualCamera {
  private readonly perspectiveDistance = 620;
  private readonly state: VisualCameraState = {
    offsetX: 0,
    offsetY: 0,
    pitch: 0,
    yaw: 0,
    zoom: 1,
  };
  private readonly minZoom = 0.84;
  private readonly maxZoom = 1.18;
  private previousDragX = 0;
  private previousDragY = 0;
  private yawVelocity = 0;
  private pitchVelocity = 0;
  private lastUpdateTimestamp: number | null = null;
  private dragging = false;
  private motionMode: VisualCameraMotionMode = 'fixed';
  private readonly autoLayers: AutoMotionLayer[] = [
    this.createAutoMotionLayer(2400, 5600, 0.044, 0.03, 0.02),
    this.createAutoMotionLayer(4200, 10200, 0.026, 0.019, 0.015),
    this.createAutoMotionLayer(7200, 16200, 0.016, 0.012, 0.011),
  ];
  private autoYaw = 0;
  private autoPitch = 0;
  private autoZoom = 0;
  private autoNeedsSync = true;
  private ambientYawVelocity = 0;
  private ambientPitchVelocity = 0;
  private ambientZoomVelocity = 0;
  private ambientYawTargetVelocity = 0;
  private ambientPitchTargetVelocity = 0;
  private ambientZoomTargetVelocity = 0;
  private nextAmbientTargetAt = Number.NEGATIVE_INFINITY;
  private reactiveYawVelocity = 0;
  private reactivePitchVelocity = 0;
  private reactiveZoomVelocity = 0;
  private lastReactiveHitAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly random: () => number = Math.random) {}

  startDrag(clientX: number, clientY: number): void {
    this.previousDragX = clientX;
    this.previousDragY = clientY;
    this.yawVelocity = 0;
    this.pitchVelocity = 0;
    this.lastUpdateTimestamp = null;
    this.dragging = true;
  }

  dragTo(clientX: number, clientY: number): void {
    if (!this.dragging) {
      return;
    }

    const deltaX = clientX - this.previousDragX;
    const deltaY = clientY - this.previousDragY;

    this.previousDragX = clientX;
    this.previousDragY = clientY;
    this.yawVelocity = -deltaX * 0.0056 * 0.52;
    this.pitchVelocity = deltaY * 0.0056 * 0.52;
    this.rotateBy(-deltaX * 0.0056, deltaY * 0.0056);
  }

  endDrag(): void {
    this.dragging = false;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  setMotionMode(mode: VisualCameraMotionMode): void {
    if (mode === this.motionMode) {
      return;
    }

    this.motionMode = mode;
    this.autoNeedsSync = true;

    if (mode === 'fixed') {
      this.reactiveYawVelocity = 0;
      this.reactivePitchVelocity = 0;
      this.reactiveZoomVelocity = 0;
    }
  }

  adjustZoom(delta: number): void {
    this.applyZoom(delta);
  }

  getState(): VisualCameraState {
    return { ...this.state };
  }

  update(timestamp: number, motionInput: VisualCameraMotionInput = defaultMotionInput): void {
    const elapsed = this.lastUpdateTimestamp === null ? 16.67 : timestamp - this.lastUpdateTimestamp;
    const frameScale = this.clamp(elapsed / 16.67, 0.25, 3);

    if (this.dragging) {
      this.lastUpdateTimestamp = timestamp;
      return;
    }

    if (this.motionMode === 'auto') {
      this.updateAutoMotion(timestamp, frameScale, motionInput);
    }

    if (Math.abs(this.yawVelocity) < 0.0001 && Math.abs(this.pitchVelocity) < 0.0001) {
      this.lastUpdateTimestamp = timestamp;
      this.yawVelocity = 0;
      this.pitchVelocity = 0;
      return;
    }
    const damping = Math.pow(0.9, frameScale);

    this.lastUpdateTimestamp = timestamp;
    this.rotateBy(this.yawVelocity * frameScale, this.pitchVelocity * frameScale);
    this.yawVelocity *= damping;
    this.pitchVelocity *= damping;
  }

  projectPoint(point: VisualCameraPoint, pivot: VisualCameraPoint = { x: 0, y: 0, z: 0 }): ProjectedVisualPoint {
    const pitchCosine = Math.cos(this.state.pitch);
    const pitchSine = Math.sin(this.state.pitch);
    const yawCosine = Math.cos(this.state.yaw);
    const yawSine = Math.sin(this.state.yaw);
    const localX = point.x - pivot.x;
    const localY = point.y - pivot.y;
    const localZ = point.z - pivot.z;
    const pitchedY = localY * pitchCosine - localZ * pitchSine;
    const pitchedZ = localY * pitchSine + localZ * pitchCosine;
    const rotatedX = localX * yawCosine + pitchedZ * yawSine;
    const rotatedZ = -localX * yawSine + pitchedZ * yawCosine;
    const depthScale = this.clamp(this.perspectiveDistance / Math.max(140, this.perspectiveDistance + rotatedZ), 0.45, 2.25);

    return {
      x: rotatedX * depthScale,
      y: pitchedY * depthScale,
      z: rotatedZ,
      depthScale,
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private applyZoom(delta: number): void {
    if (delta === 0) {
      return;
    }

    const remaining = delta > 0 ? this.maxZoom - this.state.zoom : this.state.zoom - this.minZoom;
    const range = this.maxZoom - this.minZoom;
    const resistance = 0.18 + 0.82 * Math.pow(this.clamp(remaining / range, 0, 1), 0.72);

    this.state.zoom = this.clamp(this.state.zoom + delta * resistance, this.minZoom, this.maxZoom);
  }

  private updateAutoMotion(timestamp: number, frameScale: number, motionInput: VisualCameraMotionInput): void {
    for (const layer of this.autoLayers) {
      this.updateAutoLayer(layer, timestamp);
    }

    const nextAutoYaw = this.autoLayers.reduce((sum, layer) => sum + layer.currentYaw, 0);
    const nextAutoPitch = this.autoLayers.reduce((sum, layer) => sum + layer.currentPitch, 0);
    const nextAutoZoom = this.autoLayers.reduce((sum, layer) => sum + layer.currentZoom, 0);

    if (this.autoNeedsSync) {
      this.autoYaw = nextAutoYaw;
      this.autoPitch = nextAutoPitch;
      this.autoZoom = nextAutoZoom;
      this.autoNeedsSync = false;
    }

    this.rotateBy(nextAutoYaw - this.autoYaw, nextAutoPitch - this.autoPitch);
    this.applyZoom(nextAutoZoom - this.autoZoom);
    this.autoYaw = nextAutoYaw;
    this.autoPitch = nextAutoPitch;
    this.autoZoom = nextAutoZoom;
    this.updateAmbientFlow(timestamp, frameScale);
    this.rotateBy(this.ambientYawVelocity * frameScale, this.ambientPitchVelocity * frameScale);
    this.applyZoom(this.ambientZoomVelocity * frameScale);
    this.triggerReactiveMotion(timestamp, motionInput);
    this.rotateBy(this.reactiveYawVelocity * frameScale, this.reactivePitchVelocity * frameScale);
    this.applyZoom(this.reactiveZoomVelocity * frameScale);
    const damping = Math.pow(0.972, frameScale);

    this.reactiveYawVelocity *= damping;
    this.reactivePitchVelocity *= damping;
    this.reactiveZoomVelocity *= damping;
  }

  private updateAmbientFlow(timestamp: number, frameScale: number): void {
    if (timestamp >= this.nextAmbientTargetAt) {
      this.nextAmbientTargetAt = timestamp + this.randomDuration(2000, 6200);
      this.ambientYawTargetVelocity = this.randomSigned(0.00205);
      this.ambientPitchTargetVelocity = this.randomSigned(0.00145);
      this.ambientZoomTargetVelocity = this.randomSigned(0.00108);
    }

    const blend = 1 - Math.pow(0.968, frameScale);

    this.ambientYawVelocity += (this.ambientYawTargetVelocity - this.ambientYawVelocity) * blend;
    this.ambientPitchVelocity += (this.ambientPitchTargetVelocity - this.ambientPitchVelocity) * blend;
    this.ambientZoomVelocity += (this.ambientZoomTargetVelocity - this.ambientZoomVelocity) * blend;
  }

  private triggerReactiveMotion(timestamp: number, motionInput: VisualCameraMotionInput): void {
    const hitStrength = this.clamp(
      motionInput.transient * 0.82
        + motionInput.energy * 0.38
        + motionInput.midBand * 0.2
        + motionInput.brightness * 0.14,
      0,
      1,
    );

    if (hitStrength < 0.24 || timestamp - this.lastReactiveHitAt < 110) {
      return;
    }

    this.lastReactiveHitAt = timestamp;
    const horizontalBias = this.clamp((motionInput.highBand - motionInput.lowBand) * 0.7 + (this.random() - 0.5) * 0.55, -1, 1);
    const verticalBias = this.clamp((motionInput.midBand - motionInput.lowBand) * 0.85 + (this.random() - 0.5) * 0.45, -1, 1);
    const zoomBias = this.clamp(0.004 + motionInput.energy * 0.008 + motionInput.transient * 0.01, 0.002, 0.016);

    this.reactiveYawVelocity += horizontalBias * (0.0068 + hitStrength * 0.0145);
    this.reactivePitchVelocity += verticalBias * (0.0052 + hitStrength * 0.0105);
    this.reactiveZoomVelocity += zoomBias * 1.35;
  }

  private updateAutoLayer(layer: AutoMotionLayer, timestamp: number): void {
    if (timestamp <= layer.startedAt || timestamp >= layer.startedAt + layer.durationMs) {
      layer.fromYaw = layer.currentYaw;
      layer.fromPitch = layer.currentPitch;
      layer.fromZoom = layer.currentZoom;
      layer.targetYaw = this.randomSigned(layer.yawAmplitude);
      layer.targetPitch = this.randomSigned(layer.pitchAmplitude);
      layer.targetZoom = this.randomSigned(layer.zoomAmplitude);
      layer.durationMs = this.randomDuration(layer.minDurationMs, layer.maxDurationMs);
      layer.startedAt = timestamp;
    }

    const progress = this.clamp((timestamp - layer.startedAt) / layer.durationMs, 0, 1);
    const eased = 0.5 - Math.cos(progress * Math.PI) * 0.5;

    layer.currentYaw = this.interpolate(layer.fromYaw, layer.targetYaw, eased);
    layer.currentPitch = this.interpolate(layer.fromPitch, layer.targetPitch, eased);
    layer.currentZoom = this.interpolate(layer.fromZoom, layer.targetZoom, eased);
  }

  private createAutoMotionLayer(
    minDurationMs: number,
    maxDurationMs: number,
    yawAmplitude: number,
    pitchAmplitude: number,
    zoomAmplitude: number,
  ): AutoMotionLayer {
    return {
      currentYaw: 0,
      currentPitch: 0,
      currentZoom: 0,
      fromYaw: 0,
      fromPitch: 0,
      fromZoom: 0,
      targetYaw: 0,
      targetPitch: 0,
      targetZoom: 0,
      startedAt: Number.NEGATIVE_INFINITY,
      durationMs: maxDurationMs,
      minDurationMs,
      maxDurationMs,
      yawAmplitude,
      pitchAmplitude,
      zoomAmplitude,
    };
  }

  private interpolate(from: number, to: number, progress: number): number {
    return from + (to - from) * progress;
  }

  private randomDuration(minDurationMs: number, maxDurationMs: number): number {
    return minDurationMs + (maxDurationMs - minDurationMs) * this.random();
  }

  private randomSigned(amplitude: number): number {
    return (this.random() * 2 - 1) * amplitude;
  }

  private rotateBy(yawDelta: number, pitchDelta: number): void {
    this.state.yaw = this.clamp(this.state.yaw + yawDelta, -1.2, 1.2);
    this.state.pitch = this.clamp(this.state.pitch + pitchDelta, -1.05, 1.05);
  }
}