/**
 * Acquisition & tracking supervisor — the state machine that decides what the
 * terminal is doing. Every transition is driven by observable quantities only
 * (detections, measured pixel error, miss counts, elapsed time) — never by ground
 * truth — and records the reason it happened.
 *
 *   SEARCHING ─detection─▶ DETECTED ─M of N─▶ ACQUIRING ─err<acq─▶ TRACKING ─err<lock ×n─▶ LOCKED
 *        ▲                    │ not confirmed                         ▲   │                  │
 *        └────────────────────┘                                       │   └──misses>coast──▶ LOST ──hold──▶ REACQUIRING
 *        ▲                                                            └──────── detection ──────────────────────┘
 *        └──────────────────────────────── timeout ────────────────────────────────────────────────────────────┘
 */
import { TrackLogicConfig } from '../config';
import { TrackState, TransitionEvent } from '../telemetry/types';

export interface SupervisorInput {
  t: number;
  detected: boolean;
  /** Measured distance of the detection from the image centre, px (null if none). */
  measErrPx: number | null;
  /** Filtered (Kalman) error of the optical axis vs the target estimate, px; used for lock decisions. */
  filtErrPx: number | null;
  confidence: number;
}

export class Supervisor {
  state: TrackState = 'IDLE';
  since = 0;
  misses = 0;
  private window: boolean[] = [];
  private lockCount = 0;
  private unlockCount = 0;
  lostAt: number | null = null;

  constructor(public cfg: TrackLogicConfig) {}

  reset() {
    this.state = 'IDLE';
    this.since = 0;
    this.misses = 0;
    this.window = [];
    this.lockCount = 0;
    this.unlockCount = 0;
    this.lostAt = null;
  }

  force(t: number, to: TrackState, reason: string): TransitionEvent {
    return this.go(t, to, reason);
  }

  private go(t: number, to: TrackState, message: string): TransitionEvent {
    const ev: TransitionEvent = { t, kind: 'transition', from: this.state, to, message };
    this.state = to;
    this.since = t;
    this.lockCount = 0;
    this.unlockCount = 0;
    if (to === 'DETECTED') this.window = [];
    if (to === 'LOST') this.lostAt = t;
    if (to === 'SEARCHING') this.lostAt = null;
    return ev;
  }

  get tracking(): boolean {
    return this.state === 'ACQUIRING' || this.state === 'TRACKING' || this.state === 'LOCKED';
  }

  get hasTrack(): boolean {
    return this.tracking || this.state === 'LOST' || this.state === 'REACQUIRING';
  }

  step(inp: SupervisorInput): TransitionEvent | null {
    const c = this.cfg;
    const { t, detected, measErrPx } = inp;
    if (detected) this.misses = 0;
    else this.misses++;
    const err = measErrPx ?? Infinity;
    const lockErr = inp.filtErrPx ?? err;

    switch (this.state) {
      case 'IDLE':
        return null;
      case 'SEARCHING':
        if (detected) return this.go(t, 'DETECTED', `candidate at ${err.toFixed(0)} px from centre, confidence ${(inp.confidence * 100).toFixed(0)} %`);
        return null;
      case 'DETECTED': {
        this.window.push(detected);
        const hits = this.window.filter(Boolean).length + 1; // the triggering frame counts
        if (hits >= c.confirmM) return this.go(t, 'ACQUIRING', `confirmed ${hits} of ${this.window.length + 1} frames — track initialised`);
        if (this.window.length + 1 >= c.confirmN) return this.go(t, 'SEARCHING', `not confirmed (${hits} of ${c.confirmN} frames) — rejected as noise`);
        return null;
      }
      case 'ACQUIRING':
        if (this.misses > c.coastFrames) return this.go(t, 'LOST', `${this.misses} consecutive misses while acquiring`);
        if (detected && err < c.acquirePx) return this.go(t, 'TRACKING', `measured error ${err.toFixed(1)} px < ${c.acquirePx} px`);
        return null;
      case 'TRACKING':
        if (this.misses > c.coastFrames) return this.go(t, 'LOST', `${this.misses} consecutive misses (coast limit ${c.coastFrames})`);
        if (detected && lockErr < c.lockPx) this.lockCount++;
        else if (detected) this.lockCount = 0;
        if (this.lockCount >= c.lockFrames) return this.go(t, 'LOCKED', `error < ${c.lockPx} px for ${c.lockFrames} frames`);
        return null;
      case 'LOCKED':
        if (this.misses > c.coastFrames) return this.go(t, 'LOST', `${this.misses} consecutive misses (coast limit ${c.coastFrames})`);
        if (detected && lockErr > c.unlockPx) this.unlockCount++;
        else if (detected) this.unlockCount = 0;
        if (this.unlockCount >= 3) return this.go(t, 'TRACKING', `error > ${c.unlockPx} px for 3 frames`);
        return null;
      case 'LOST':
        if (detected) return this.go(t, 'TRACKING', `reacquired after ${(t - (this.lostAt ?? t)).toFixed(2)} s (coasting on prediction)`);
        if (t - this.since >= c.lostHoldS) return this.go(t, 'REACQUIRING', `no return after ${c.lostHoldS.toFixed(2)} s — local search around prediction`);
        return null;
      case 'REACQUIRING':
        if (detected) return this.go(t, 'TRACKING', `reacquired after ${(t - (this.lostAt ?? t)).toFixed(2)} s`);
        if (t - (this.lostAt ?? this.since) >= c.reacquireTimeoutS)
          return this.go(t, 'SEARCHING', `reacquisition timeout ${c.reacquireTimeoutS} s — global search`);
        return null;
    }
  }
}
