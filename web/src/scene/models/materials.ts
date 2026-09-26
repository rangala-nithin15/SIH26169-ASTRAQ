/** Procedural PBR materials for the models (no image assets). */
import * as THREE from 'three';

function canvasTex(size: number, draw: (x: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

export function makeMaterials() {
  const mli = canvasTex(512, (x, s) => {
    const g = x.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, '#b8892f');
    g.addColorStop(0.5, '#e0b85a');
    g.addColorStop(1, '#a87a26');
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      x.strokeStyle = `rgba(${rnd() < 0.5 ? '255,235,170' : '90,60,15'},${0.08 + rnd() * 0.18})`;
      x.lineWidth = 1 + rnd() * 3;
      x.beginPath();
      const px = rnd() * s;
      const py = rnd() * s;
      x.moveTo(px, py);
      x.lineTo(px + (rnd() - 0.5) * 60, py + (rnd() - 0.5) * 60);
      x.stroke();
    }
  });
  const mliRough = canvasTex(
    256,
    (x, s) => {
      x.fillStyle = '#555';
      x.fillRect(0, 0, s, s);
      for (let i = 0; i < 500; i++) {
        const v = 40 + rnd() * 120;
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(rnd() * s, rnd() * s, 4 + rnd() * 20, 2 + rnd() * 8);
      }
    },
    false,
  );
  const cells = canvasTex(512, (x, s) => {
    x.fillStyle = '#0b1733';
    x.fillRect(0, 0, s, s);
    const n = 8;
    const c = s / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const g = x.createLinearGradient(i * c, j * c, (i + 1) * c, (j + 1) * c);
        g.addColorStop(0, '#132a5c');
        g.addColorStop(1, '#0a1838');
        x.fillStyle = g;
        x.fillRect(i * c + 3, j * c + 3, c - 6, c - 6);
        x.fillStyle = 'rgba(180,200,230,0.35)';
        for (let k = 1; k < 4; k++) x.fillRect(i * c + 3, j * c + (k * c) / 4, c - 6, 1);
      }
    x.strokeStyle = 'rgba(200,210,225,0.7)';
    x.lineWidth = 3;
    x.strokeRect(1, 1, s - 2, s - 2);
  });
  const radiator = canvasTex(256, (x, s) => {
    x.fillStyle = '#e8ebee';
    x.fillRect(0, 0, s, s);
    x.fillStyle = 'rgba(120,130,140,0.35)';
    for (let i = 8; i < s; i += 16) x.fillRect(i, 0, 2, s);
  });
  const shelter = canvasTex(1024, (x, s) => {
    x.fillStyle = '#cdd2d6';
    x.fillRect(0, 0, s, s);
    x.strokeStyle = 'rgba(70,78,86,0.55)';
    x.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      x.beginPath();
      x.moveTo((i * s) / 4, 0);
      x.lineTo((i * s) / 4, s);
      x.stroke();
    }
    x.beginPath();
    x.moveTo(0, s * 0.62);
    x.lineTo(s, s * 0.62);
    x.stroke();
    // Louvre vents.
    x.fillStyle = 'rgba(40,46,52,0.75)';
    for (let k = 0; k < 7; k++) x.fillRect(s * 0.58, s * 0.14 + k * 18, s * 0.14, 9);
    // Hazard stripe along the base.
    for (let k = -2; k < 40; k++) {
      x.fillStyle = k % 2 ? '#e0a53a' : '#1d2228';
      x.beginPath();
      x.moveTo(k * 32, s);
      x.lineTo(k * 32 + 32, s);
      x.lineTo(k * 32 + 52, s - 26);
      x.lineTo(k * 32 + 20, s - 26);
      x.fill();
    }
    x.fillStyle = '#2a3036';
    x.font = '600 58px Barlow Condensed, Arial Narrow, sans-serif';
    x.fillText('ASTRAQ · FSOC-T1', s * 0.06, s * 0.46);
    x.font = '500 30px Barlow Condensed, Arial Narrow, sans-serif';
    x.fillText('MOBILE OPTICAL GROUND TERMINAL', s * 0.06, s * 0.52);
  });
  const tread = canvasTex(256, (x, s) => {
    x.fillStyle = '#111316';
    x.fillRect(0, 0, s, s);
    x.fillStyle = '#1c1f23';
    for (let i = 0; i < s; i += 22) {
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i + 12, s / 2);
      x.lineTo(i, s);
      x.lineTo(i + 8, s);
      x.lineTo(i + 20, s / 2);
      x.lineTo(i + 8, 0);
      x.fill();
    }
  });

  // Crinkled-foil bump map (MLI blankets are never flat).
  const crinkle = canvasTex(
    512,
    (x, s) => {
      x.fillStyle = '#808080';
      x.fillRect(0, 0, s, s);
      for (let i = 0; i < 1400; i++) {
        const v = rnd() < 0.5 ? 200 : 55;
        x.strokeStyle = `rgba(${v},${v},${v},${0.18 + rnd() * 0.3})`;
        x.lineWidth = 1 + rnd() * 5;
        x.beginPath();
        const px = rnd() * s;
        const py = rnd() * s;
        x.moveTo(px, py);
        x.quadraticCurveTo(px + (rnd() - 0.5) * 70, py + (rnd() - 0.5) * 70, px + (rnd() - 0.5) * 90, py + (rnd() - 0.5) * 90);
        x.stroke();
      }
    },
    false,
  );
  // Solar array: triple-junction cells in a grid, silver interconnects, white gaps.
  const cells2 = canvasTex(1024, (x, s) => {
    x.fillStyle = '#c9ced6';
    x.fillRect(0, 0, s, s);
    const nx = 8;
    const ny = 12;
    const cw = s / nx;
    const ch = s / ny;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const g = x.createLinearGradient(i * cw, j * ch, (i + 1) * cw, (j + 1) * ch);
        const tint = rnd() * 0.08;
        g.addColorStop(0, `rgb(${22 + tint * 60},${30 + tint * 40},${70 + tint * 90})`);
        g.addColorStop(1, `rgb(${10 + tint * 40},${14 + tint * 30},${40 + tint * 60})`);
        x.fillStyle = g;
        x.fillRect(i * cw + 3, j * ch + 3, cw - 6, ch - 6);
        x.fillStyle = 'rgba(190,200,215,0.55)';
        x.fillRect(i * cw + 3, j * ch + ch / 2 - 1, cw - 6, 2);
        for (let k = 1; k < 6; k++) x.fillRect(i * cw + 3 + (k * (cw - 6)) / 6, j * ch + 3, 1, ch - 6);
      }
    x.strokeStyle = 'rgba(210,215,222,0.95)';
    x.lineWidth = 8;
    x.strokeRect(4, 4, s - 8, s - 8);
  });
  // Container shelter: corrugated panels, doors, placards.
  const containerTex = canvasTex(1024, (x, s) => {
    x.fillStyle = '#e3e6e8';
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i += 32) {
      const g = x.createLinearGradient(i, 0, i + 32, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.18)');
      g.addColorStop(0.5, 'rgba(120,128,136,0.1)');
      g.addColorStop(1, 'rgba(255,255,255,0.16)');
      x.fillStyle = g;
      x.fillRect(i, 0, 32, s);
    }
    x.fillStyle = 'rgba(40,52,70,0.9)';
    x.fillRect(0, s * 0.8, s, s * 0.035);
    x.fillStyle = '#c0392b';
    x.fillRect(0, s * 0.835, s, s * 0.012);
    x.fillStyle = '#26303b';
    x.font = '700 64px Barlow Condensed, Arial Narrow, sans-serif';
    x.fillText('ASTRAQ  ·  FSOC-T1', s * 0.06, s * 0.3);
    x.font = '500 30px Barlow Condensed, Arial Narrow, sans-serif';
    x.fillText('TRANSPORTABLE OPTICAL GROUND TERMINAL', s * 0.06, s * 0.36);
    x.fillStyle = 'rgba(30,36,44,0.8)';
    for (let k = 0; k < 8; k++) x.fillRect(s * 0.78, s * 0.14 + k * 16, s * 0.14, 8);
    x.strokeStyle = 'rgba(60,68,78,0.6)';
    x.lineWidth = 3;
    x.strokeRect(s * 0.5, s * 0.2, s * 0.2, s * 0.58);
    x.fillStyle = '#f2b01e';
    x.beginPath();
    x.moveTo(s * 0.93, s * 0.5);
    x.lineTo(s * 0.97, s * 0.57);
    x.lineTo(s * 0.89, s * 0.57);
    x.fill();
  });
  const containerBump = canvasTex(
    256,
    (x, s) => {
      for (let i = 0; i < s; i++) {
        const v = Math.round(128 + 50 * Math.sin((i / 8) * Math.PI));
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(i, 0, 1, s);
      }
    },
    false,
  );
  const tyre = canvasTex(256, (x, s) => {
    x.fillStyle = '#16181b';
    x.fillRect(0, 0, s, s);
    x.fillStyle = '#0c0d0f';
    for (let i = 0; i < s; i += 18) {
      x.fillRect(i, 0, 8, s * 0.42);
      x.fillRect(i + 9, s * 0.58, 8, s * 0.42);
    }
  });

  return {
    gold: new THREE.MeshStandardMaterial({ map: mli, roughnessMap: mliRough, bumpMap: crinkle, bumpScale: 1.4, metalness: 1, roughness: 0.3, envMapIntensity: 1.4 }),
    silverFoil: new THREE.MeshStandardMaterial({ color: '#d9dde2', bumpMap: crinkle, bumpScale: 1.2, metalness: 1, roughness: 0.22, envMapIntensity: 1.4 }),
    cells2: new THREE.MeshPhysicalMaterial({ map: cells2, metalness: 0.35, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.8 }),
    panelBack2: new THREE.MeshStandardMaterial({ color: '#6b727c', metalness: 0.45, roughness: 0.5 }),
    frame: new THREE.MeshStandardMaterial({ color: '#b8bec6', metalness: 0.85, roughness: 0.32 }),
    paint: new THREE.MeshPhysicalMaterial({ color: '#e8ebee', metalness: 0.1, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    trim: new THREE.MeshStandardMaterial({ color: '#23272c', metalness: 0.4, roughness: 0.55 }),
    chassis: new THREE.MeshStandardMaterial({ color: '#17191c', metalness: 0.5, roughness: 0.6 }),
    container: new THREE.MeshStandardMaterial({ map: containerTex, bumpMap: containerBump, bumpScale: 0.8, metalness: 0.2, roughness: 0.55 }),
    interior: new THREE.MeshStandardMaterial({ color: '#15191e', metalness: 0.2, roughness: 0.8, side: THREE.DoubleSide }),
    tyre: new THREE.MeshStandardMaterial({ map: tyre, metalness: 0, roughness: 0.95 }),
    rim: new THREE.MeshStandardMaterial({ color: '#4a5058', metalness: 0.8, roughness: 0.35 }),
    orange: new THREE.MeshStandardMaterial({ color: '#ff6a13', roughness: 0.55 }),
    reflect: new THREE.MeshStandardMaterial({ color: '#f4f6f8', emissive: '#9aa4ae', emissiveIntensity: 0.2, roughness: 0.3 }),
    headlight: new THREE.MeshStandardMaterial({ color: '#fff7e6', emissive: '#ffe7b8', emissiveIntensity: 3, toneMapped: false }),
    redLaser: new THREE.MeshStandardMaterial({ color: '#ff2a2a', emissive: '#ff1a1a', emissiveIntensity: 4, toneMapped: false }),
    gold_old: new THREE.MeshStandardMaterial({ map: mli, roughnessMap: mliRough, metalness: 1, roughness: 0.32, envMapIntensity: 1.3 }),
    silver: new THREE.MeshStandardMaterial({ color: '#c7ccd2', metalness: 0.9, roughness: 0.28 }),
    blackAnod: new THREE.MeshStandardMaterial({ color: '#15181c', metalness: 0.65, roughness: 0.38 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: '#2b3137', metalness: 0.55, roughness: 0.5 }),
    cells: new THREE.MeshStandardMaterial({ map: cells, metalness: 0.45, roughness: 0.22, envMapIntensity: 1.5 }),
    panelBack: new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.3, roughness: 0.6 }),
    radiator: new THREE.MeshStandardMaterial({ map: radiator, metalness: 0.1, roughness: 0.55 }),
    whitePaint: new THREE.MeshStandardMaterial({ color: '#e4e7ea', metalness: 0.15, roughness: 0.45 }),
    body: new THREE.MeshStandardMaterial({ color: '#262d33', metalness: 0.45, roughness: 0.52 }),
    shelter: new THREE.MeshStandardMaterial({ map: shelter, metalness: 0.15, roughness: 0.6 }),
    rubber: new THREE.MeshStandardMaterial({ map: tread, color: '#ffffff', metalness: 0, roughness: 0.92 }),
    cable: new THREE.MeshStandardMaterial({ color: '#0d0f11', metalness: 0.1, roughness: 0.7 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#0b1620', metalness: 0.2, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 2 }),
    lens: new THREE.MeshPhysicalMaterial({
      color: '#07131d',
      metalness: 0.1,
      roughness: 0.03,
      clearcoat: 1,
      iridescence: 1,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [250, 600],
      envMapIntensity: 2.5,
      emissive: new THREE.Color('#1c6f8f'),
      emissiveIntensity: 0.25,
    }),
    amber: new THREE.MeshStandardMaterial({ color: '#ffb547', emissive: '#ff9a1a', emissiveIntensity: 2, toneMapped: false }),
    concrete: new THREE.MeshStandardMaterial({ color: '#8d9196', roughness: 0.9 }),
  };
}

export type Materials = ReturnType<typeof makeMaterials>;
