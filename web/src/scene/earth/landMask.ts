/**
 * Builds an equirectangular land/coast texture at runtime from Natural Earth land
 * polygons (world-atlas, public domain) — no image assets are shipped.
 *   R: land mask (sharp)     G: coastal proximity (blurred mask)     B: unused
 */
import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

type Ring = [number, number][];

export async function buildLandTexture(width: number): Promise<THREE.CanvasTexture> {
  const topo = (await import('world-atlas/land-50m.json')).default as unknown as Topology<{ land: GeometryCollection }>;
  const land = feature(topo, topo.objects.land) as unknown as GeoJSON.FeatureCollection;
  const height = width / 2;
  const sharp = document.createElement('canvas');
  sharp.width = width;
  sharp.height = height;
  const ctx = sharp.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  const X = (lon: number) => ((lon + 180) / 360) * width;
  const Y = (lat: number) => ((90 - lat) / 180) * height;

  const drawRing = (ring: Ring, offset: number) => {
    // Unwrap longitudes so rings crossing the antimeridian stay continuous.
    let prev = ring[0][0];
    let acc = prev;
    ctx.moveTo(X(acc + offset), Y(ring[0][1]));
    const pts: [number, number][] = [[acc, ring[0][1]]];
    for (let i = 1; i < ring.length; i++) {
      let d = ring[i][0] - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      acc += d;
      prev = ring[i][0];
      pts.push([acc, ring[i][1]]);
      ctx.lineTo(X(acc + offset), Y(ring[i][1]));
    }
    const span = acc - ring[0][0];
    if (Math.abs(span) > 300) {
      // Polar ring (Antarctica): close it along the pole.
      const poleLat = pts.reduce((a, p) => a + p[1], 0) < 0 ? -90 : 90;
      ctx.lineTo(X(acc + offset), Y(poleLat));
      ctx.lineTo(X(ring[0][0] + offset), Y(poleLat));
    }
    ctx.closePath();
  };

  for (const f of land.features) {
    const g = f.geometry;
    const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : [];
    for (const poly of polys) {
      for (const offset of [-360, 0, 360]) {
        ctx.beginPath();
        for (const ring of poly) drawRing(ring, offset);
        ctx.fill('evenodd');
      }
    }
  }

  // Coastal proximity: blurred copy of the mask.
  const blur = document.createElement('canvas');
  blur.width = width / 4;
  blur.height = height / 4;
  const bctx = blur.getContext('2d')!;
  bctx.filter = `blur(${Math.max(2, width / 1024)}px)`;
  bctx.drawImage(sharp, 0, 0, blur.width, blur.height);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d')!;
  // R channel ← sharp mask; G channel ← blurred mask (via additive compositing).
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, width, height);
  octx.globalCompositeOperation = 'lighter';
  octx.drawImage(tint(sharp, [1, 0, 0]), 0, 0);
  octx.drawImage(tint(blur, [0, 1, 0]), 0, 0, width, height);
  octx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function tint(src: HTMLCanvasElement, rgb: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const x = c.getContext('2d')!;
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = `rgb(${rgb[0] * 255},${rgb[1] * 255},${rgb[2] * 255})`;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}
