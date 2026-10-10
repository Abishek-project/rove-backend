import sharp from 'sharp';

/** Locally generated, license-free imagery for seed data (no downloaded photos). */

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 0xff;
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Shape = 'hatch' | 'sedan' | 'suv' | 'coupe';

const BODY: Record<Shape, { body: string; rear: string; front: string; wheels: [number, number] }> = {
  hatch: {
    body: 'M230 540 Q228 470 300 455 L420 440 Q490 350 590 340 L760 340 Q815 345 845 430 L960 450 Q1000 460 1000 510 L1000 548 Q1000 565 980 565 L250 565 Q228 565 230 540 Z',
    rear: 'M450 438 Q505 362 590 358 L650 358 L650 438 Z',
    front: 'M670 358 L755 358 Q795 362 822 438 L670 438 Z',
    wheels: [355, 860],
  },
  sedan: {
    body: 'M170 535 Q172 470 250 455 L400 438 Q480 352 580 342 L760 342 Q850 348 905 432 L1010 450 Q1050 462 1050 512 L1050 548 Q1050 565 1028 565 L192 565 Q168 565 170 535 Z',
    rear: 'M430 436 Q495 364 580 360 L650 360 L650 436 Z',
    front: 'M670 360 L758 360 Q830 366 872 436 L670 436 Z',
    wheels: [330, 890],
  },
  suv: {
    body: 'M180 545 Q176 450 250 432 L380 420 Q430 300 520 292 L800 292 Q880 296 930 410 L1015 430 Q1050 442 1050 500 L1050 552 Q1050 572 1028 572 L200 572 Q178 572 180 545 Z',
    rear: 'M405 418 Q450 318 525 312 L650 312 L650 418 Z',
    front: 'M670 312 L795 312 Q860 316 900 418 L670 418 Z',
    wheels: [340, 890],
  },
  coupe: {
    body: 'M160 540 Q165 488 240 474 L420 452 Q520 370 640 362 L760 364 Q880 380 960 455 L1035 470 Q1065 480 1062 520 L1060 550 Q1058 565 1036 565 L180 565 Q158 565 160 540 Z',
    rear: 'M470 450 Q545 384 640 380 L680 380 L680 450 Z',
    front: 'M700 381 L760 382 Q850 394 912 450 L700 450 Z',
    wheels: [330, 900],
  },
};

export function shapeFor(category: string, model: string): Shape {
  if (category === 'suv') return 'suv';
  if (/911|coupe|gt/i.test(model)) return 'coupe';
  if (category === 'economy') return 'hatch';
  return 'sedan';
}

export function carSvg(v: {
  make: string;
  model: string;
  year: number;
  category: string;
  transmission: string;
  color: string;
  hex: string;
}): string {
  const shape = BODY[shapeFor(v.category, v.model)];
  const light = shade(v.hex, 0.35);
  const dark = shade(v.hex, -0.35);
  const wheel = (cx: number) => `
    <circle cx="${cx}" cy="565" r="72" fill="#1d2228"/>
    <circle cx="${cx}" cy="565" r="44" fill="#aab3bd"/>
    <circle cx="${cx}" cy="565" r="14" fill="#5e6873"/>
    ${[0, 72, 144, 216, 288]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<line x1="${cx}" y1="565" x2="${(cx + 40 * Math.cos(r)).toFixed(1)}" y2="${(565 + 40 * Math.sin(r)).toFixed(1)}" stroke="#7d8792" stroke-width="7"/>`;
      })
      .join('')}`;
  const cat = v.category === 'suv' ? 'SUV' : v.category.charAt(0).toUpperCase() + v.category.slice(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f8fb"/><stop offset="1" stop-color="#dfe5ee"/></linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${v.hex}"/><stop offset="1" stop-color="${dark}"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4a5c"/><stop offset="1" stop-color="#1c2633"/></linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  <rect y="640" width="1200" height="160" fill="#d3dae4"/>
  <ellipse cx="610" cy="632" rx="470" ry="30" fill="#000" opacity="0.14"/>
  <path d="${shape.body}" fill="url(#body)" stroke="${dark}" stroke-width="3"/>
  <path d="${shape.rear}" fill="url(#glass)"/>
  <path d="${shape.front}" fill="url(#glass)"/>
  <rect x="${shape.wheels[0] + 120}" y="478" width="60" height="8" rx="4" fill="${dark}" opacity="0.6"/>
  <rect x="${shape.wheels[1] - 230}" y="478" width="60" height="8" rx="4" fill="${dark}" opacity="0.6"/>
  <ellipse cx="${shape.wheels[1] + 125}" cy="488" rx="26" ry="12" fill="#fff6c9"/>
  <rect x="${shape.wheels[0] - 160}" y="480" width="26" height="20" rx="6" fill="#d9363e"/>
  ${wheel(shape.wheels[0])}
  ${wheel(shape.wheels[1])}
  <text x="72" y="118" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="58" font-weight="700" fill="#18212d">${esc(v.make)} ${esc(v.model)}</text>
  <text x="74" y="172" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" fill="#566273">${v.year} · ${cat} · ${v.transmission === 'automatic' ? 'Automatic' : 'Manual'} · ${esc(v.color)}</text>
  <text x="1128" y="760" text-anchor="end" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="22" fill="#7c8796">Illustration · Rove sample listing</text>
</svg>`;
}

export function specsSvg(v: { make: string; model: string; hex: string; specs: string[] }): string {
  const rows = v.specs
    .map(
      (s, i) =>
        `<text x="120" y="${300 + i * 70}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="38" fill="#ffffff">• ${esc(s)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(v.hex, -0.15)}"/><stop offset="1" stop-color="${shade(v.hex, -0.6)}"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <circle cx="1020" cy="160" r="220" fill="#ffffff" opacity="0.07"/>
  <text x="120" y="180" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="60" font-weight="700" fill="#ffffff">${esc(v.make)} ${esc(v.model)}</text>
  ${rows}
  <text x="1128" y="760" text-anchor="end" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="22" fill="#ffffff" opacity="0.7">Rove sample listing</text>
</svg>`;
}

export async function svgToJpeg(svg: string): Promise<{ buffer: Buffer; width: number; height: number }> {
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return { buffer, width: 1200, height: 800 };
}

export async function cardPng(title: string, subtitle: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560">
  <rect width="900" height="560" rx="28" fill="#eef2f7"/><rect x="24" y="24" width="852" height="512" rx="20" fill="#ffffff" stroke="#c9d2de" stroke-width="3"/>
  <rect x="60" y="150" width="200" height="250" rx="12" fill="#d5dce6"/>
  <text x="60" y="100" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#1b2430">${esc(title)}</text>
  <text x="300" y="200" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#4b5664">${esc(subtitle)}</text>
  <text x="300" y="260" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#c0392b">SAMPLE — NOT A REAL DOCUMENT</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Tiny valid single-page PDF with a few text lines (for seeded verification documents). */
export function samplePdf(lines: string[]): Buffer {
  const text = ['SAMPLE - NOT A REAL DOCUMENT', ...lines]
    .map((l, i) => `BT /F1 ${i === 0 ? 20 : 14} Tf 72 ${770 - i * 28} Td (${l.replace(/[()\\]/g, '')}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
