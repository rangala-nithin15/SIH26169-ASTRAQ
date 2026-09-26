/** Hash-based 3D value noise + fBm (GLSL), written for ASTRAQ's procedural surfaces. */
export const NOISE_GLSL = /* glsl */ `
float aq_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float aq_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(aq_hash(i + vec3(0,0,0)), aq_hash(i + vec3(1,0,0)), f.x),
        mix(aq_hash(i + vec3(0,1,0)), aq_hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(aq_hash(i + vec3(0,0,1)), aq_hash(i + vec3(1,0,1)), f.x),
        mix(aq_hash(i + vec3(0,1,1)), aq_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float aq_fbm(vec3 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * aq_noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return s;
}
`;
