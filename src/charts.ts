import sharp from 'sharp';

// ── Layout constants ──────────────────────────────────────────────────────────
const CELL    = 28;           // cell square size
const GAP     = 4;            // gap between cells
const STEP    = CELL + GAP;   // 32 — distance between cell origins

const WEEKS   = 8;
const DAYS    = 7;

const GRID_W  = WEEKS * STEP;  // 256
const GRID_H  = DAYS  * STEP;  // 224

const PAD       = 20;
const LABEL_W   = 38;          // left column width for day labels
const TITLE_H   = 20;          // height of section title row
const WKLBL_H   = 16;          // height of week-date label row
const LEG_GAP   = 8;           // gap between grid and legend
const LEG_H     = CELL;        // legend swatch height = cell size
const SECTION_H = TITLE_H + WKLBL_H + GRID_H + LEG_GAP + LEG_H + 10;
//              = 20 + 16 + 224 + 8 + 28 + 10 = 306

const HEADER_H    = 30;
const SECTION_GAP = 20;

const W = PAD + LABEL_W + GRID_W + PAD;                                    // 334
const H = PAD + HEADER_H + SECTION_H + SECTION_GAP + SECTION_H + PAD;     // 20+30+306+20+306+20 = 702

// ── Colour palettes (5 levels: 0=empty → 4=max) ──────────────────────────────
const BLUE  = ['#ebedf0', '#c6e0f5', '#79c0e0', '#1f8fcb', '#0a5680'];
const GREEN = ['#ebedf0', '#c8e6c9', '#81c784', '#388e3c', '#1b5e20'];

const BG      = '#ffffff';
const TEXT_DK = '#24292e';
const TEXT_LT = '#8b949e';

const FONT = 'DejaVu Sans,Liberation Sans,Helvetica,Arial,sans-serif';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Only render labels on Mon, Wed, Fri, Sun to avoid cramping
const SHOW_DAY   = [true, false, true, false, true, false, true];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Map a value to one of the 5 palette levels. Returns palette[0] for zero. */
function colorLevel(val: number, max: number, palette: string[]): string {
  if (val === 0 || max === 0) return palette[0];
  const idx = Math.round((val / max) * (palette.length - 1));
  return palette[Math.max(1, Math.min(idx, palette.length - 1))];
}

function t(
  x: number, y: number, content: string,
  opts: { size?: number; weight?: string; fill?: string; anchor?: string } = {}
): string {
  const size   = opts.size   ?? 11;
  const weight = opts.weight ?? 'normal';
  const fill   = opts.fill   ?? TEXT_DK;
  const anchor = opts.anchor ?? 'start';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" `
       + `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">`
       + `${esc(content)}</text>`;
}

// ── Public types ──────────────────────────────────────────────────────────────
export interface DayStats {
  feedMl:     number;
  nappyCount: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generates a PNG image containing two GitHub-style activity heatmaps:
 *   top    = daily ml consumed (blue scale)
 *   bottom = daily nappy changes (green scale)
 *
 * @param data         Map of YYYY-MM-DD → DayStats
 * @param babyName     Displayed in the header
 * @param todayDateStr 'YYYY-MM-DD' in the configured timezone
 * @param tz           IANA timezone string for date labels
 */
export async function generateTrendsImage(
  data:          Map<string, DayStats>,
  babyName:      string,
  todayDateStr:  string,
  tz:            string
): Promise<Buffer> {
  // ── Date alignment ─────────────────────────────────────────────────────────
  const todayDate = new Date(todayDateStr + 'T12:00:00Z');
  // 0=Mon … 6=Sun
  const todayDow  = (todayDate.getUTCDay() + 6) % 7;
  const thisMonday = new Date(todayDate);
  thisMonday.setUTCDate(todayDate.getUTCDate() - todayDow);

  // Grid column 0 = Monday of the oldest displayed week
  const gridStart = new Date(thisMonday);
  gridStart.setUTCDate(thisMonday.getUTCDate() - (WEEKS - 1) * 7);

  const cellDateStr = (col: number, row: number): string => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + col * 7 + row);
    return d.toISOString().slice(0, 10);
  };
  const cellDate = (col: number, row: number): Date => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + col * 7 + row);
    return d;
  };

  // ── Scale values ───────────────────────────────────────────────────────────
  let maxMl = 0, maxNappy = 0;
  for (const v of data.values()) {
    if (v.feedMl     > maxMl)    maxMl    = v.feedMl;
    if (v.nappyCount > maxNappy) maxNappy = v.nappyCount;
  }

  // ── SVG build ──────────────────────────────────────────────────────────────
  const el: string[] = [];
  el.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  el.push(`<rect width="${W}" height="${H}" rx="10" fill="${BG}"/>`);

  // Header
  el.push(t(PAD, PAD + 18, `${babyName}'s activity — last ${WEEKS} weeks`,
    { size: 14, weight: '700' }));

  // ── Section renderer ────────────────────────────────────────────────────────
  const x0 = PAD + LABEL_W;  // x of grid column 0

  function renderSection(
    sY:       number,
    title:    string,
    getValue: (s: DayStats) => number,
    maxVal:   number,
    palette:  string[],
    maxLabel: string,
  ) {
    const gridY = sY + TITLE_H + WKLBL_H;

    // Title
    el.push(t(PAD, sY + 14, title, { size: 12, weight: '600' }));

    // Week column date labels (every other column to avoid overlap)
    for (let col = 0; col < WEEKS; col += 2) {
      const lbl = cellDate(col, 0).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', timeZone: tz,
      });
      el.push(t(x0 + col * STEP, sY + TITLE_H + 12, lbl, { size: 9, fill: TEXT_LT }));
    }

    // Day-of-week labels + grid cells
    for (let row = 0; row < DAYS; row++) {
      if (SHOW_DAY[row]) {
        el.push(t(
          x0 - 4, gridY + row * STEP + CELL - 7,
          DAY_LABELS[row],
          { size: 9, fill: TEXT_LT, anchor: 'end' }
        ));
      }
      for (let col = 0; col < WEEKS; col++) {
        const ds = cellDateStr(col, row);
        if (ds > todayDateStr) continue;           // no future cells

        const v     = data.get(ds);
        const val   = v ? getValue(v) : 0;
        const fill  = colorLevel(val, maxVal, palette);
        const cx    = x0 + col * STEP;
        const cy    = gridY + row * STEP;

        el.push(`<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="4" fill="${fill}"/>`);

        // Outline today's cell
        if (ds === todayDateStr) {
          el.push(`<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" `
                + `rx="4" fill="none" stroke="${TEXT_DK}" stroke-width="2"/>`);
        }
      }
    }

    // Colour legend
    const legY  = gridY + GRID_H + LEG_GAP;
    el.push(t(x0 - 4, legY + CELL - 7, 'Less', { size: 9, fill: TEXT_LT, anchor: 'end' }));
    for (let i = 0; i < palette.length; i++) {
      el.push(`<rect x="${x0 + i * (CELL + 3)}" y="${legY}" `
            + `width="${CELL}" height="${CELL}" rx="3" fill="${palette[i]}"/>`);
    }
    el.push(t(
      x0 + palette.length * (CELL + 3) + 4,
      legY + CELL - 7,
      `More  (max: ${maxLabel})`,
      { size: 9, fill: TEXT_LT }
    ));
  }

  const sec1Y = PAD + HEADER_H;
  const sec2Y = sec1Y + SECTION_H + SECTION_GAP;

  renderSection(sec1Y,
    'Feeds  (ml / day)',
    v => v.feedMl,
    maxMl,
    BLUE,
    maxMl > 0 ? `${maxMl} ml` : 'none so far'
  );
  renderSection(sec2Y,
    'Nappies  (changes / day)',
    v => v.nappyCount,
    maxNappy,
    GREEN,
    maxNappy > 0 ? `${maxNappy}` : 'none so far'
  );

  el.push('</svg>');

  return sharp(Buffer.from(el.join(''))).png().toBuffer();
}
