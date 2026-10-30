// Reads the tank's percentage from a photo without any AI: it finds the dark display panel, finds the bright digits inside it,
// and checks which of the seven bars of each digit are lit. Free, private, and instant, so it runs on the phone itself.
// The picture must already be upright (see CAMERA_ROTATE). A reading it is not sure about comes back as null, never as a guess.
const SEGS = { // the seven bars of a digit, as [x0, x1, y0, y1] fractions of the digit's box
  a: [0.2, 0.8, 0, 0.17], b: [0.7, 1, 0.08, 0.47], c: [0.7, 1, 0.53, 0.92], d: [0.2, 0.8, 0.83, 1],
  e: [0, 0.3, 0.53, 0.92], f: [0, 0.3, 0.08, 0.47], g: [0.2, 0.8, 0.41, 0.59],
};
const ORDER = "abcdefg";
const DIGITS = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
const ALT = { 6: ["cdefg"], 7: ["abcf"], 9: ["abcfg"] }; // some displays draw 6, 7 and 9 slightly differently
const WORK_W = 640;

const lumAt = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// connected regions of a boolean mask (8-way); returns [{ x0, y0, x1, y1, n, px:[idx...] }]
function regions(mask, W, H, keepPixels = false) {
  const seen = new Uint8Array(W * H), out = [], stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const r = { x0: W, y0: H, x1: 0, y1: 0, n: 0, px: keepPixels ? [] : null };
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p - x) / W;
      r.n++; if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y; if (keepPixels) r.px.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push(r);
  }
  return out;
}

// 1. the display panel: the dark, roughly square region with a blue ring around it. The ring is what identifies it, so it is found even while the digits
// are switched off (the tank blinks the number while it charges). Without a ring, fall back to the dark square with the most white pixels in it.
function findPanel(d, W, H) {
  const dark = new Uint8Array(W * H), white = new Uint8Array(W * H), blue = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) { const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2]; dark[p] = lumAt(d, i) < 50 ? 1 : 0; white[p] = Math.min(r, g, b) > 170 ? 1 : 0; blue[p] = b > 120 && b > r + 60 && b > g - 20 ? 1 : 0; }
  let best = null;
  for (const r of regions(dark, W, H, true)) {
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    if (r.n < W * H * 0.008 || w < W * 0.1 || h < W * 0.1 || w / h < 0.75 || w / h > 1.35) continue; // the tank's panel is close to square
    const ix0 = Math.round(r.x0 + w * 0.1), ix1 = Math.round(r.x1 - w * 0.1), iy0 = Math.round(r.y0 + h * 0.1), iy1 = Math.round(r.y1 - h * 0.1);
    let white_n = 0; for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) white_n += white[y * W + x];
    // blue ring: some blue just outside each of the four sides
    const m = Math.max(3, Math.round(w * 0.08)), band = (xa, xb, ya, yb) => { let n = 0; for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y++) for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) n += blue[y * W + x]; return n; };
    const sides = [band(r.x0, r.x1, r.y0 - m, r.y0 + 1), band(r.x0, r.x1, r.y1 - 1, r.y1 + m), band(r.x0 - m, r.x0 + 1, r.y0, r.y1), band(r.x1 - 1, r.x1 + m, r.y0, r.y1)];
    const ring = Math.min(...sides) >= 6 ? sides.reduce((a, b) => a + b, 0) : 0;
    const score = ring ? 100000 + ring : white_n > 25 ? white_n : 0; // a ring always beats a mere pile of white pixels
    if (score && (!best || score > best.score)) {
      const lo = new Int32Array(H).fill(W), hi = new Int32Array(H).fill(-1); // the panel's left and right edge on every row, so the white case in its rounded corners can be ignored
      for (const p of r.px) { const x = p % W, y = (p - x) / W; if (x < lo[y]) lo[y] = x; if (x > hi[y]) hi[y] = x; }
      best = { x0: ix0, y0: iy0, x1: ix1, y1: iy1, score, lo, hi, ring: ring > 0 };
    }
  }
  return best;
}

// 2. the digits, read at full resolution: tall bright shapes inside the panel, split where a column of the panel has nothing lit.
// (the % sign and battery icon are shorter, and the thin frame is dimmer than the digits)
function findDigits(full, panel, scale, thrFrac = 0.7) {
  const inside = (x, y) => { const wy = Math.floor(y / scale), wx = x / scale; return wx > panel.lo[wy] + 4 && wx < panel.hi[wy] - 4 && panel.hi[wy] >= 0; };
  const { width: FW, data: d } = full.bitmap;
  const x0 = Math.floor(panel.x0 * scale), x1 = Math.ceil(panel.x1 * scale), y0 = Math.floor(panel.y0 * scale), y1 = Math.ceil(panel.y1 * scale), pw = x1 - x0 + 1, ph = y1 - y0 + 1;
  let peak = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) peak = Math.max(peak, lumAt(d, (y * FW + x) * 4));
  const thr = Math.max(150, peak * thrFrac), mask = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (inside(x0 + x, y0 + y) && lumAt(d, ((y0 + y) * FW + x0 + x) * 4) > thr) mask[y * pw + x] = 1;
  // the digits are the biggest cluster of lit pixels (grown a little so each digit's bars hold together); button icons are far smaller
  const grown = new Uint8Array(pw * ph), R = 4;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (mask[y * pw + x]) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < pw && ny < ph) grown[ny * pw + nx] = 1; }
  let main = null;
  for (const r of regions(grown, pw, ph)) { let n = 0; for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) n += mask[y * pw + x]; if (!main || n > main.n) main = { ...r, n }; }
  if (!main) return { digits: [], thr, mask, pw, ph, peak };
  // the biggest cluster only tells us which rows the digits are on; everything lit on those rows (every digit, the % sign, the battery icon) is kept
  const hh = main.y1 - main.y0, padT = Math.round(hh * 0.1), padB = Math.round(hh * 0.4), col = new Uint16Array(pw); // the % sign sits lower than the digits, so the band reaches further down than up
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) { if (y < main.y0 - padT || y > main.y1 + padB) mask[y * pw + x] = 0; else if (mask[y * pw + x]) col[x]++; }
  // columns with next to nothing lit separate the digits; a group is a run of lit columns
  const groups = []; let start = -1;
  for (let x = 0; x <= pw; x++) {
    const on = x < pw && col[x] > 1;
    if (on && start < 0) start = x; else if (!on && start >= 0) { groups.push([start, x - 1]); start = -1; }
  }
  const shapes = groups.map(([a, b]) => {
    let ya = ph, yb = 0; for (let y = 0; y < ph; y++) for (let x = a; x <= b; x++) if (mask[y * pw + x]) { if (y < ya) ya = y; if (y > yb) yb = y; }
    const h = yb - ya + 1, third = Math.max(1, Math.floor(h / 3)); let tx = 0, tn = 0, bx = 0, bn = 0;
    for (let y = ya; y < ya + third; y++) for (let x = a; x <= b; x++) if (mask[y * pw + x]) { tx += x; tn++; }
    for (let y = yb - third + 1; y <= yb; y++) for (let x = a; x <= b; x++) if (mask[y * pw + x]) { bx += x; bn++; }
    const slope = 0; // (the digits lean only slightly; the bar boxes are wide enough that no correction is needed)
    const ymid = (ya + yb) / 2; let da = Infinity, db = -Infinity; // the digit's box once the lean is undone
    for (let y = ya; y <= yb; y++) for (let x = a; x <= b; x++) if (mask[y * pw + x]) { const u = x - slope * (ymid - y); if (u < da) da = u; if (u > db) db = u; }
    return { x0: a, x1: b, y0: ya, y1: yb, h, slope, ymid, u0: da, u1: db, w: db - da + 1 };
  }).filter((g) => g.h > 0);
  const tallest = Math.max(0, ...shapes.map((g) => g.h));
  return { digits: shapes.filter((g) => g.h >= tallest * 0.7 && g.h >= ph * 0.12), all: shapes, thr, mask, pw, ph, peak };
}

// 3. one digit: how much of each of its seven bars is lit (with the lean undone), and which number that matches best
function classify(mask, pw, ph, g, cellW) {
  const frac = {}, u0 = g.u1 - cellW + 1, w = cellW, h = g.h;
  for (const k of ORDER) {
    const [a0, a1, b0, b1] = SEGS[k]; let lit = 0, tot = 0;
    for (let y = Math.floor(g.y0 + b0 * h); y <= Math.ceil(g.y0 + b1 * h - 1); y++) for (let u = Math.floor(u0 + a0 * w); u <= Math.ceil(u0 + a1 * w - 1); u++) {
      const x = Math.round(u + g.slope * (g.ymid - y)); tot++; if (x >= 0 && x < pw && y >= 0 && y < ph && mask[y * pw + x]) lit++;
    }
    frac[k] = tot ? lit / tot : 0;
  }
  const top = Math.max(...Object.values(frac), 0.01); for (const k of ORDER) frac[k] = Math.min(1, frac[k] / top); // judge each bar against the brightest bar of the same digit
  const dist = Object.entries(DIGITS).map(([n, set]) => [Number(n), Math.min(...[set, ...(ALT[n] ?? [])].map((t) => [...ORDER].reduce((s, k) => s + Math.abs(frac[k] - (t.includes(k) ? 1 : 0)), 0)))]).sort((p, q) => p[1] - q[1]);
  const [best, second] = dist, ok = best[1] < 1.7 && second[1] - best[1] > 0.3; // an 8 differs from a 0, 6 or 9 by one bar, so the margin can be small and still be right
  return { digit: ok ? best[0] : null, dist: +best[1].toFixed(2), margin: +(second[1] - best[1]).toFixed(2), frac };
}

// img: an upright Jimp image. Returns { value, note, digits } where value is 0-100 or null.
// When the camera is further away the glow around the bright digits can join two of them (a 7 and a 4 reading as one wide shape). Counting only the very brightest pixels
// separates them again, so a read that fails with "digits run together" is retried with a stricter cut.
export function readDisplay(img) {
  let r;
  for (const frac of [0.7, 0.8, 0.88, 0.94, 0.97]) { r = readDisplayAt(img, frac); if (r.value != null || !/run together|digit unclear/.test(r.note)) return r; }
  return r;
}
function readDisplayAt(img, thrFrac) {
  const s = img.bitmap.width > WORK_W ? img.clone().resize({ w: WORK_W }) : img, { width: W, height: H, data: d } = s.bitmap, scale = img.bitmap.width / W;
  const panel = findPanel(d, W, H); if (!panel) return { value: null, note: "display not found", digits: [] };
  const where = { x0: panel.x0 * scale, y0: panel.y0 * scale, w: (panel.x1 - panel.x0) * scale, ring: panel.ring }; // where the display is, so other things can be found relative to it
  let { digits, all, mask, pw, ph } = findDigits(img, panel, scale, thrFrac);
  // The % sign is the lit shape at the far right of the display: it reaches past 64% of the panel's width and no digit does. Its HEIGHT doesn't matter (the battery icon above it
  // comes and goes with the tank's output switch, so the sign is sometimes tall and sometimes short). Everything else, to its left, is a digit.
  const pctShape = (all ?? []).filter((g) => g.x1 / where.w >= 0.64 && g.x0 / where.w >= 0.575).sort((a, b) => b.x1 - a.x1)[0] ?? null;
  digits = digits.filter((g) => g !== pctShape && (!pctShape || g.x1 < pctShape.x0));
  if (!digits.length) return { value: null, blank: true, note: pctShape ? "display blank (the tank blinks the number while it charges)" : "display blank", digits: [], panel: where };
  if (digits.some((g) => g.w / where.w > 0.12 || (g.x0 / where.w < 0.372 && g.w / where.w > 0.05))) return { value: null, note: "digits run together (a shape is too wide to be one digit)", digits: [], panel: where }; // one digit is about 0.10 of the panel wide; a shape starting where only a leading 1 can start must be narrow
  if (digits.some((g) => g.w > g.h * 0.95)) return { value: null, note: "digits run together (display tilted?)", digits: [], panel: where }; // one digit is never wider than this, so two have merged and one would be lost
  // sanity checks: the % sign must be there, right beside the digits, and everything must sit level. If not, the picture is not trustworthy (tilted, or a digit is missing).
  if (!pctShape) return { value: null, note: "no % sign found", digits: [], panel: where };
  { const hMax = Math.max(...digits.map((g) => g.h)), ys = digits.map((g) => g.y1);
    if (Math.max(...ys) - Math.min(...ys) > hMax * 0.15 || Math.abs(pctShape.y1 - digits[digits.length - 1].y1) > hMax * 0.25) return { value: null, note: "digits not level (display tilted?)", digits: [], panel: where }; }
  // the layout is fixed on this tank: the % sign and the last digit always sit at the same place across the panel (measured 0.607-0.623 and 0.589-0.610 of its width,
  // whatever the lighting, zoom or position). If they are elsewhere the picture is tilted or moved too far to trust, and what is left could read as a different number.
  { const pctX = pctShape.x0 / where.w, lastX1 = digits[digits.length - 1].x1 / where.w;
    if (pctX < 0.59 || pctX > 0.633 || lastX1 < 0.57 || lastX1 > 0.632) return { value: null, note: "layout is off (phone tilted or moved?)", digits: [], panel: where }; }
  if (digits.length > 3) return { value: null, note: `${digits.length} shapes, expected 1-3`, digits: [], panel: where };
  const wide = digits.filter((g) => g.w >= g.h * 0.4), cellW = wide.length ? Math.max(...wide.map((g) => g.w)) : Math.round(digits[0].h * 0.55);
  // the % sign sits right beside the last digit; a digit-sized gap there means a digit was too dim to see, and what is left would look like a smaller number
  if (pctShape && pctShape.x0 - digits[digits.length - 1].x1 > cellW * 0.5) return { value: null, note: "a digit is missing next to the % sign", digits: [], panel: where };
  const narrow = (g) => g.w < g.h * 0.4; // a "1" is about a quarter as wide as it is tall, every other digit more than half (judged against its own height: with two 1s there is no wide digit to compare with)
  const cells = digits.map((g) => ({ ...g, ...classify(mask, pw, ph, g, narrow(g) ? cellW : g.w) }));
  // a narrow shape that fits no digit is the "1" of a number like 100: only its two right bars are lit
  // (a shape this narrow can only be a 1, so its top and bottom bars, which a wide cell overlaps with the glow, are not judged)
  for (const c of cells) if (narrow(c)) { const one = c.frac.b > 0.4 && c.frac.c > 0.4 && c.frac.e < 0.25 && c.frac.f < 0.25 && c.frac.g < 0.35; c.digit = one ? 1 : null; }
  if (cells.some((c) => c.digit === null)) return { value: null, note: "digit unclear", digits: cells, panel: where };
  const value = Number(cells.map((c) => c.digit).join(""));
  if (!(value >= 0 && value <= 100)) return { value: null, note: `implausible ${value}`, digits: cells, panel: where };
  const geom = { pctX: pctShape.x0 / where.w, lastX1: digits[digits.length - 1].x1 / where.w, h: Math.max(...digits.map((g) => g.h)) / where.w, n: digits.length };
  return { value, note: "", digits: cells, panel: where, geom };
}

// The red light on the wall socket above the tank (lit while the grid supplies it). Where it appears depends on where the phone stands, so it is searched for
// in the whole area above the display: the reddest point that sits on a LIGHT surface (the socket's faceplate). The red digits of the meter box beside it are on a dark
// surface, so they are ignored. Measured on real photos: lit = 99-191, unlit = 5-51, so 75 separates them.
export const GRID_LIGHT_THRESHOLD = 75;
export function readGridLight(img, panel) {
  if (!panel) return null;
  const { width: W, height: H, data: d } = img.bitmap, { x0, y0, w } = panel;
  const xa = Math.max(0, Math.floor(x0 - 1.6 * w)), xb = Math.min(W - 1, Math.floor(x0 + 3.6 * w)), ya = Math.max(0, Math.floor(y0 - 4.2 * w)), yb = Math.min(H - 1, Math.floor(y0 - 0.8 * w));
  if (xb <= xa || yb <= ya) return { score: 0, on: false };
  const integ = new Float64Array((W + 1) * (H + 1)); // brightness sums over the picture, so the average around any point is quick to get
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; row += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row; } }
  const R = Math.round(0.4 * w), mean = (x, y) => { const x1 = Math.max(0, x - R), y1 = Math.max(0, y - R), x2 = Math.min(W, x + R + 1), y2 = Math.min(H, y + R + 1); return (integ[y2 * (W + 1) + x2] - integ[y1 * (W + 1) + x2] - integ[y2 * (W + 1) + x1] + integ[y1 * (W + 1) + x1]) / ((x2 - x1) * (y2 - y1)); };
  let peak = 0;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    const i = (y * W + x) * 4, sc = d[i] - (d[i + 1] + d[i + 2]) / 2; if (sc < 40 || d[i] < 90 || sc <= peak) continue;
    if (mean(x, y) >= 60) peak = sc; // a red point in a fairly bright surrounding (the socket and the wall), not in the dark glass of the meter box
  }
  return { score: Math.round(peak), on: peak >= GRID_LIGHT_THRESHOLD };
}

// Reads the display even if the phone has been knocked a little: if the normal read fails, try small counter-tilts and remember the one that worked.
let lastAngle = 0, lastSearchAt = 0;
export function readDisplayAuto(img) {
  const canSearch = Date.now() - lastSearchAt > 5 * 60e3; // a full search at most every 5 minutes, so an unreadable photo can't keep the phone busy
  const order = [lastAngle, 0, ...(canSearch ? [3, -3, 6, -6, 9, -9] : [])].filter((a, k, arr) => arr.indexOf(a) === k);
  let first = null;
  for (const a of order) {
    const im = a ? img.clone().rotate(a) : img, r = readDisplay(im);
    first ??= r;
    if (r.value != null) { lastAngle = a; return { ...r, angle: a, image: im }; }
    if (r.note === "display not found" || r.blank || r.note === "digit unclear") break; // tilting won't help if the display isn't in the picture, is blank, or a digit is merely unclear (that is not a tilt problem, and a rotated guess can be wrong)
    if (a !== lastAngle && a !== 0) lastSearchAt = Date.now();
  }
  return { ...first, angle: 0, image: img };
}
export const resetAutoSearch = () => { lastAngle = 0; lastSearchAt = 0; }; // for tests: forget the remembered tilt and the search rate limit
