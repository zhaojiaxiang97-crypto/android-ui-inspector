import { constrainOrbitCamera, type OrbitCamera, type OrbitRotationMode } from "../../../shared/orbit-camera";
import { mixCamera, motionProgress } from "./motion";

export type CameraScheduler = {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
};

/** Owns the painted camera and its two RAF queues. React only receives commits/destinations. */
export function createCanvasCamera(initial: OrbitCamera, rotationMode: OrbitRotationMode, effects: {
  paint: (camera: OrbitCamera) => void;
  commit: (camera: OrbitCamera) => void;
  progress: (progress: number) => void;
}, scheduler: CameraScheduler) {
  let current = constrainOrbitCamera(initial, rotationMode);
  let frame: number | null = null, motionFrame: number | null = null;
  let motion: { from: OrbitCamera; to: OrbitCamera; started: number } | null = null;
  // Cancellation also invalidates callbacks already handed to the browser.
  let paintEpoch = 0, motionEpoch = 0;
  let interruptedMotion = false;
  const normalize = (camera: OrbitCamera) => constrainOrbitCamera(camera, rotationMode);
  function cancelPaint() {
    paintEpoch++;
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
  }
  function interrupt() {
    motionEpoch++;
    if (motionFrame !== null) scheduler.cancel(motionFrame);
    motionFrame = null;
    if (!motion && !interruptedMotion) return;
    motion = null; interruptedMotion = false;
    effects.progress(1);
    current = normalize(current);
    effects.commit({ ...current });
    effects.paint(current);
  }
  function commit(next: OrbitCamera) {
    interrupt(); cancelPaint();
    current = normalize(next);
    effects.paint(current);
    effects.commit(current);
  }
  function schedule(next: OrbitCamera) {
    current = normalize(next);
    if (frame !== null) return;
    const epoch = paintEpoch;
    frame = scheduler.request(() => {
      if (epoch !== paintEpoch) return;
      frame = null;
      effects.paint(current);
    });
  }
  function animate(next: OrbitCamera, enabled: boolean) {
    next = normalize(next);
    interrupt(); cancelPaint();
    if (!enabled || scheduler.reducedMotion()) { commit(next); return; }
    motion = { from: { ...normalize(current) }, to: next, started: scheduler.now() };
    effects.commit(next);
    const epoch = motionEpoch;
    const tick = () => {
      if (epoch !== motionEpoch) return;
      motionFrame = null;
      if (!motion) return;
      const progress = scheduler.reducedMotion() ? 1 : motionProgress(motion.started, scheduler.now());
      current = normalize(mixCamera(motion.from, motion.to, progress));
      effects.paint(current);
      effects.progress(progress);
      if (progress < 1) motionFrame = scheduler.request(tick);
      else motion = null;
    };
    tick();
  }
  return {
    read: () => current,
    schedule, commit, animate, interrupt,
    repaint: (committed: OrbitCamera) => {
      if (!motion && !interruptedMotion) current = normalize(committed);
      effects.paint(current);
    },
    setRotationMode: (next: OrbitRotationMode) => { rotationMode = next; commit(current); },
    finishMotion: () => { if (motion) commit(motion.to); },
    cancelPending: () => {
      cancelPaint(); motionEpoch++;
      if (motionFrame !== null) scheduler.cancel(motionFrame);
      // A context handoff must still commit the last painted frame on interrupt.
      interruptedMotion ||= Boolean(motion);
      motionFrame = null; motion = null;
    },
  };
}
export type CanvasCamera = ReturnType<typeof createCanvasCamera>;
