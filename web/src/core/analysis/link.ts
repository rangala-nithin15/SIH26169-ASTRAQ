/**
 * Simplified optical link & acquisition estimates. Everything here is an explicit,
 * documented approximation — shown in the UI together with its formula.
 *
 * Link budget (downlink beacon/comm beam from the remote terminal to the ground):
 *   Gaussian beam, far field. Full-angle 1/e² divergence θ → beam radius w = R·θ/2.
 *   Fraction collected by a circular aperture of radius a: η = 1 − exp(−2a²/w²).
 *   Atmospheric loss = mode attenuation × airmass (1/sin el, capped at 10).
 *   Receive pointing loss (coupling into the fine-stage field of view, 1/e² half-width
 *   = fine capture angle): L_p = exp(−2 (θ_err / θ_fine)²).
 *   Pr = Pt + 10log10(η) − L_atm − L_sys − L_p   (dBm)
 * Not modelled: scintillation fade statistics, background radiance, detector noise.
 *
 * Acquisition probability within 2 s (search-coverage model):
 *   P_view0  = min(1, A_fov / A_field)
 *   A_cov(T) = A_fov + ω_max · v_fov · T      (area the scan can sweep in T)
 *   P_det    = Φ(SNR − k)                     (per-frame detection probability)
 *   P_acq(T) = min(1, A_cov(T) / A_field) · (1 − (1 − P_det)^n_frames_in_view)
 */
import { SimConfig, intrinsics } from '../config';
import { normCdf } from '../math';
import { LinkEstimate } from '../telemetry/types';
import { atmosphereEffect } from '../disturbance/disturbance';

export function linkEstimate(cfg: SimConfig, rangeKm: number, elDeg: number, pointingErrDeg: number): LinkEstimate {
  const L = cfg.link;
  const R = rangeKm * 1000;
  const theta = L.divergenceUrad * 1e-6;
  const w = (R * theta) / 2;
  const a = L.rxApertureCm / 200;
  const eta = 1 - Math.exp((-2 * a * a) / (w * w));
  const geomLossDb = -10 * Math.log10(Math.max(1e-30, eta));
  const atm = atmosphereEffect(cfg.disturbance.atmosphere, cfg.disturbance.atmosphereStrength);
  const airmass = Math.min(10, 1 / Math.max(0.1, Math.sin((Math.max(1, elDeg) * Math.PI) / 180)));
  const atmLossDb = atm.attenuationDb * airmass;
  const fine = (L.fineCaptureMrad * 1e-3 * 180) / Math.PI; // deg
  const pointingLossDb = Math.min(60, (10 / Math.LN10) * 2 * (pointingErrDeg / fine) ** 2);
  const ptDbm = 10 * Math.log10(L.txPowerMw);
  const prDbm = ptDbm - geomLossDb - atmLossDb - L.systemLossDb - pointingLossDb;
  const acq = acquisitionProbability(cfg);
  return {
    rangeKm,
    geomLossDb,
    atmLossDb,
    pointingLossDb,
    prDbm,
    marginDb: prDbm - L.rxSensitivityDbm,
    fineHandover: pointingErrDeg <= fine,
    pAcquire2s: acq.pAcq,
    pInitialInView: acq.pView0,
    pDetectFrame: acq.pDet,
  };
}

export function acquisitionProbability(cfg: SimConfig, T = 2) {
  const cam = cfg.camera;
  const k = intrinsics(cam, cam.wideAcquisition ? cam.wideHfovDeg : cam.hfovDeg);
  const aFov = k.hfovDeg * k.vfovDeg;
  const aField = 4 * cfg.logic.searchHalfUDeg * cfg.logic.searchHalfVDeg;
  const pView0 = Math.min(1, aFov / aField);
  const aCov = aFov + cfg.gimbal.maxRateDegS * k.vfovDeg * T;
  const d = cfg.disturbance;
  const atm = atmosphereEffect(d.atmosphere, d.atmosphereStrength);
  // Peak signal of the box-filtered spot vs. box-filtered noise σ (≈ σ/3).
  const signal = cfg.target.beaconIntensity * atm.transmission * atm.gain;
  const noise = Math.max(0.5, Math.sqrt(d.gaussianNoise ** 2 + (d.poisson ? 0.45 * (12 + atm.airlightGrey) : 0)) / 3);
  const snr = signal / noise;
  const pDetRaw = normCdf(snr - 2.4 * cfg.detection.thresholdSigma);
  const pDet = pDetRaw * (1 - Math.min(0.98, d.dropoutProb + atm.extraDropout));
  const nFrames = Math.max(1, Math.round(cam.frameRateHz * 0.4));
  const pAcq = Math.min(1, aCov / aField) * (1 - Math.pow(1 - pDet, nFrames));
  return { pView0, pDet, pAcq, snr };
}
