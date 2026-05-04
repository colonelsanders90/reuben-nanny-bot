import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { readFileSync } from 'fs';

// ── Font registration (runs once at module load) ──────────────────────────────
// Bundle Roboto Latin via @fontsource/roboto so we're independent of whatever
// fonts the server has installed.
try {
  GlobalFonts.register(
    readFileSync(require.resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff2')),
    'Roboto'
  );
  GlobalFonts.register(
    readFileSync(require.resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff2')),
    'Roboto'
  );
} catch (e) {
  console.warn('[charts] Roboto font failed to load — text may render as boxes:', (e as Error).message);
}

// ── Layout ────────────────────────────────────────────────────────────────────
const CELL  = 28;
const GAP   = 4;
const STEP  = CELL + GAP;  // 32

const WEEKS = 8;
const DAYS  = 7;

const GRID_W = WEEKS * STEP;  // 256
const GRID_H = DAYS  * STEP;  // 224

const PAD       = 20;
const LABEL_W   = 44;   // left margin for day-name labels
const W         = PAD + LABEL_W + GRID_W + PAD;  // 340

const HEADER_H  = 36;   // global header row
const SEC_TITLE = 24;   // per-section title height
const WKLBL_H   = 18;   // week-date label row
const LEG_GAP   = 10;   // space between grid bottom and legend
const LEG_H     = CELL; // legend swatch height  (= 28)
const LEG_PAD   = 14;   // padding after legend to next section

const SECTION_H = SEC_TITLE + WKLBL_H + GRID_H + LEG_GAP + LEG_H + LEG_PAD;
//              = 24 + 18 + 224 + 10 + 28 + 14 = 318

const SEC_GAP = 22;     // gap between the two heatmap sections
const H = PAD + HEADER_H + SECTION_H + SEC_GAP + SECTION_H + PAD;
//      = 20 + 36 + 318 + 22 + 318 + 20 = 734

// ── Colour palettes ───────────────────────────────────────────────────────────
const CREAM = ['#edebe6', '#fdf4d3', '#f9e080', '#f0b830', '#c88a0a'];
const BROWN = ['#edebe6', '#e8cfad', '#c49060', '#906038', '#5a3318'];

const BG      = '#ffffff';
const TEXT_DK = '#24292e';
const TEXT_LT = '#8b949e';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHOW_DAY   = [true, false, true, false, true, false, true];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a value to one of the 5 palette levels; always >= level 1 for non-zero. */
function colorLevel(val: number, max: number, palette: string[]): string {
  if (val === 0 || max === 0) return palette[0];
  const idx = Math.round((val / max) * (palette.length - 1));
  return palette[Math.max(1, Math.min(idx, palette.length - 1))];
}

/** Draw a filled rounded rectangle, optionally with a stroke outline. */
function roundRect(
  ctx: any,
  x: number, y: number, w: number, h: number, r: number,
  fill: string, stroke?: string
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h,     x, y + h - r,     r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y,         x + r, y,         r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = 2;
    ctx.stroke();
  }
}

// ── Public types ──────────────────────────────────────────────────────────────
export interface DayStats {
  feedMl:     number;
  nappyCount: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns a PNG Buffer containing two GitHub-style heatmaps stacked vertically:
 *   top    = daily ml consumed  (white → blue)
 *   bottom = daily nappy changes (white → green)
 *
 * @param data          Map of YYYY-MM-DD → DayStats
 * @param babyName      Shown in the chart header
 * @param todayDateStr  Today as 'YYYY-MM-DD' in the local timezone
 * @param tz            IANA timezone for date labels
 */
export async function generateTrendsImage(
  data:          Map<string, DayStats>,
  babyName:      string,
  todayDateStr:  string,
  tz:            string
): Promise<Buffer> {
  // ── Date grid alignment ────────────────────────────────────────────────────
  const todayDate  = new Date(todayDateStr + 'T12:00:00Z');
  const todayDow   = (todayDate.getUTCDay() + 6) % 7;   // 0 = Mon … 6 = Sun
  const thisMonday = new Date(todayDate);
  thisMonday.setUTCDate(todayDate.getUTCDate() - todayDow);

  // col 0 = Monday of the oldest displayed week
  const gridStart = new Date(thisMonday);
  gridStart.setUTCDate(thisMonday.getUTCDate() - (WEEKS - 1) * 7);

  const cellDs = (col: number, row: number): string => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + col * 7 + row);
    return d.toISOString().slice(0, 10);
  };
  const cellDt = (col: number, row: number): Date => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + col * 7 + row);
    return d;
  };

  // ── Scale maxima ───────────────────────────────────────────────────────────
  let maxMl = 0, maxNappy = 0;
  for (const v of data.values()) {
    if (v.feedMl     > maxMl)    maxMl    = v.feedMl;
    if (v.nappyCount > maxNappy) maxNappy = v.nappyCount;
  }

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d') as any;

  // Background
  roundRect(ctx, 0, 0, W, H, 10, BG);

  const x0 = PAD + LABEL_W;  // left edge of grid column 0

  // Global header
  ctx.fillStyle = TEXT_DK;
  ctx.font      = 'bold 14px Roboto';
  ctx.textAlign = 'left';
  ctx.fillText(`${babyName}’s activity — last ${WEEKS} weeks`, PAD, PAD + 22);

  // ── Per-section renderer ───────────────────────────────────────────────────
  function renderSection(
    sY:       number,
    title:    string,
    getValue: (s: DayStats) => number,
    maxVal:   number,
    palette:  string[],
    maxLabel: string
  ) {
    const gridY = sY + SEC_TITLE + WKLBL_H;

    // Section title
    ctx.font      = 'bold 12px Roboto';
    ctx.fillStyle = TEXT_DK;
    ctx.textAlign = 'left';
    ctx.fillText(title, PAD, sY + 16);

    // Week-start date labels (every other column to avoid crowding)
    ctx.font      = '9px Roboto';
    ctx.fillStyle = TEXT_LT;
    for (let col = 0; col < WEEKS; col += 2) {
      const lbl = cellDt(col, 0).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', timeZone: tz,
      });
      ctx.textAlign = 'left';
      ctx.fillText(lbl, x0 + col * STEP, sY + SEC_TITLE + 12);
    }

    // Grid rows
    for (let row = 0; row < DAYS; row++) {
      // Day-name label on the left (Mon / Wed / Fri / Sun)
      if (SHOW_DAY[row]) {
        ctx.font      = '9px Roboto';
        ctx.fillStyle = TEXT_LT;
        ctx.textAlign = 'right';
        ctx.fillText(DAY_LABELS[row], x0 - 6, gridY + row * STEP + CELL - 7);
      }

      // Heatmap cells
      for (let col = 0; col < WEEKS; col++) {
        const ds = cellDs(col, row);
        if (ds > todayDateStr) continue;   // no future cells

        const v     = data.get(ds);
        const val   = v ? getValue(v) : 0;
        const fill  = colorLevel(val, maxVal, palette);
        const cx    = x0 + col * STEP;
        const cy    = gridY + row * STEP;
        const today = ds === todayDateStr ? TEXT_DK : undefined;
        roundRect(ctx, cx, cy, CELL, CELL, 4, fill, today);
      }
    }

    // Colour legend
    const legY = gridY + GRID_H + LEG_GAP;

    ctx.font      = '9px Roboto';
    ctx.fillStyle = TEXT_LT;
    ctx.textAlign = 'right';
    ctx.fillText('Less', x0 - 6, legY + CELL - 7);

    for (let i = 0; i < palette.length; i++) {
      roundRect(ctx, x0 + i * (CELL + 3), legY, CELL, CELL, 3, palette[i]);
    }

    ctx.textAlign = 'left';
    ctx.fillText(
      `More  (max: ${maxLabel})`,
      x0 + palette.length * (CELL + 3) + 6,
      legY + CELL - 7
    );
  }

  const sec1Y = PAD + HEADER_H;
  const sec2Y = sec1Y + SECTION_H + SEC_GAP;

  renderSection(
    sec1Y,
    'Feeds  (ml / day)',
    v => v.feedMl, maxMl, CREAM,
    maxMl > 0 ? `${maxMl} ml` : 'none yet'
  );
  renderSection(
    sec2Y,
    'Nappies  (changes / day)',
    v => v.nappyCount, maxNappy, BROWN,
    maxNappy > 0 ? String(maxNappy) : 'none yet'
  );

  return canvas.toBuffer('image/png');
}

// ── Feed vs Sleep correlation chart ──────────────────────────────────────────

export interface FeedSleepDay {
  feedCount:     number;
  avgSleepHours: number | null;
}

const FS_DAYS    = 14;
const FS_BAR_W   = 12;
const FS_CHART_H = 100;
const FS_TITLE_H = 20;
const FS_XLBL_H  = 22;
const FS_SEC_H   = FS_TITLE_H + FS_CHART_H + FS_XLBL_H;  // 142
const FS_SEC_GAP = 16;
const FS_H       = PAD + HEADER_H + FS_SEC_H + FS_SEC_GAP + FS_SEC_H + PAD;  // 376

const FS_LPAD    = 36;
const FS_X0      = PAD + FS_LPAD;                         // 56
const FS_CHART_W = W - PAD - FS_LPAD - PAD;               // 264
const FS_BSTEP   = Math.floor(FS_CHART_W / FS_DAYS);      // 18

const BAR_FEED   = '#5b8dee';
const BAR_SLEEP  = '#ff9a3c';
const BAR_EMPTY  = '#edebe6';
const GRID_LINE  = '#f0ede8';
const AXIS_LINE  = '#d0cdc8';

/**
 * Returns a PNG Buffer with two stacked bar charts for the last 14 days:
 *   top    = feeds per day  (blue bars)
 *   bottom = avg sleep between feeds in hours  (orange bars)
 */
export async function generateFeedSleepChart(
  data:         Map<string, FeedSleepDay>,
  babyName:     string,
  fromDateStr:  string,
  todayDateStr: string,
): Promise<Buffer> {
  const canvas = createCanvas(W, FS_H);
  const ctx    = canvas.getContext('2d') as any;

  roundRect(ctx, 0, 0, W, FS_H, 10, BG);

  ctx.fillStyle = TEXT_DK;
  ctx.font      = 'bold 14px Roboto';
  ctx.textAlign = 'left';
  ctx.fillText(`${babyName}'s feed & sleep — last ${FS_DAYS} days`, PAD, PAD + 22);

  // Build ordered date list for the window
  const dates: string[] = [];
  {
    let d = new Date(fromDateStr + 'T12:00:00Z');
    const end = new Date(todayDateStr + 'T12:00:00Z');
    while (d <= end) {
      dates.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86_400_000);
    }
  }

  let maxFeeds = 1, maxSleep = 0.1;
  for (const v of data.values()) {
    if (v.feedCount > maxFeeds) maxFeeds = v.feedCount;
    if (v.avgSleepHours !== null && v.avgSleepHours > maxSleep) maxSleep = v.avgSleepHours;
  }

  function renderSection(
    sY:       number,
    title:    string,
    barColor: string,
    getValue: (d: FeedSleepDay) => number | null,
    maxVal:   number,
    yTopLbl:  string,
  ) {
    const chartTop = sY + FS_TITLE_H;
    const chartBot = chartTop + FS_CHART_H;

    ctx.font      = 'bold 12px Roboto';
    ctx.fillStyle = TEXT_DK;
    ctx.textAlign = 'left';
    ctx.fillText(title, PAD, sY + 14);

    // Horizontal gridlines at 50% and 100%
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth   = 1;
    for (const frac of [0.5, 1.0]) {
      const gy = chartBot - Math.round(frac * FS_CHART_H);
      ctx.beginPath();
      ctx.moveTo(FS_X0, gy);
      ctx.lineTo(FS_X0 + FS_CHART_W, gy);
      ctx.stroke();
    }

    // Y-axis labels
    ctx.font      = '9px Roboto';
    ctx.fillStyle = TEXT_LT;
    ctx.textAlign = 'right';
    ctx.fillText('0',     FS_X0 - 4, chartBot + 3);
    ctx.fillText(yTopLbl, FS_X0 - 4, chartTop  + 5);

    // Bars + x-axis labels
    for (let i = 0; i < dates.length; i++) {
      const day   = dates[i];
      const stats = data.get(day);
      const val   = stats ? getValue(stats) : null;
      const bx    = FS_X0 + i * FS_BSTEP + Math.floor((FS_BSTEP - FS_BAR_W) / 2);

      if (val === null || val === 0) {
        roundRect(ctx, bx, chartBot - 4, FS_BAR_W, 4, 1, BAR_EMPTY);
      } else {
        const barH = Math.max(4, Math.round((val / maxVal) * FS_CHART_H));
        roundRect(ctx, bx, chartBot - barH, FS_BAR_W, barH, 2, barColor);
      }

      // Date label every 2 bars
      if (i % 2 === 0) {
        const dt  = new Date(day + 'T12:00:00Z');
        const lbl = `${dt.getUTCDate()} ${dt.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
        ctx.font      = '8px Roboto';
        ctx.fillStyle = TEXT_LT;
        ctx.textAlign = 'center';
        ctx.fillText(lbl, bx + FS_BAR_W / 2, chartBot + 14);
      }
    }

    // Bottom axis line
    ctx.strokeStyle = AXIS_LINE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(FS_X0, chartBot);
    ctx.lineTo(FS_X0 + FS_CHART_W, chartBot);
    ctx.stroke();
  }

  const sec1Y = PAD + HEADER_H;
  const sec2Y = sec1Y + FS_SEC_H + FS_SEC_GAP;

  renderSection(sec1Y, 'Feeds per day',                    BAR_FEED,
    v => v.feedCount,     maxFeeds, String(maxFeeds));
  renderSection(sec2Y, 'Avg sleep between feeds (hours)',  BAR_SLEEP,
    v => v.avgSleepHours, maxSleep, maxSleep.toFixed(1) + 'h');

  return canvas.toBuffer('image/png');
}

// ── ml vs Sleep correlation chart ─────────────────────────────────────────────

export interface MlSleepBucket {
  amountMl:  number;
  avgSleepH: number;
  count:     number;
}

const ML_CHART_H = 140;
const ML_XLBL_H  = 34;   // two lines: ml label + n= count
const ML_NOTE_H  = 18;
const ML_H       = PAD + HEADER_H + FS_TITLE_H + ML_CHART_H + ML_XLBL_H + ML_NOTE_H + PAD;
// = 20 + 36 + 20 + 140 + 34 + 18 + 20 = 288

const BAR_ML = '#9c6ade';

/**
 * Returns a PNG Buffer showing avg sleep duration after each feed amount.
 * Each bar = one distinct ml amount; height = avg hours until next feed.
 */
export async function generateMlSleepChart(
  buckets:  MlSleepBucket[],
  babyName: string,
  days:     number,
): Promise<Buffer> {
  const canvas = createCanvas(W, ML_H);
  const ctx    = canvas.getContext('2d') as any;

  roundRect(ctx, 0, 0, W, ML_H, 10, BG);

  ctx.fillStyle = TEXT_DK;
  ctx.font      = 'bold 14px Roboto';
  ctx.textAlign = 'left';
  ctx.fillText(`${babyName}'s milk vs sleep`, PAD, PAD + 22);

  ctx.font      = 'bold 12px Roboto';
  ctx.fillStyle = TEXT_DK;
  ctx.fillText('Avg sleep after each feed amount', PAD, PAD + HEADER_H + 14);

  const LPAD   = 36;
  const x0     = PAD + LPAD;
  const chartW = W - PAD - LPAD - PAD;   // 264

  const chartTop = PAD + HEADER_H + FS_TITLE_H;
  const chartBot = chartTop + ML_CHART_H;

  const shown = buckets.slice(0, 12);
  const n     = shown.length;

  let maxSleep = 0.1;
  for (const b of shown) if (b.avgSleepH > maxSleep) maxSleep = b.avgSleepH;

  // Gridlines at 50% and 100%
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth   = 1;
  for (const frac of [0.5, 1.0]) {
    const gy = chartBot - Math.round(frac * ML_CHART_H);
    ctx.beginPath();
    ctx.moveTo(x0, gy);
    ctx.lineTo(x0 + chartW, gy);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.font      = '9px Roboto';
  ctx.fillStyle = TEXT_LT;
  ctx.textAlign = 'right';
  ctx.fillText('0',                       x0 - 4, chartBot + 3);
  ctx.fillText(maxSleep.toFixed(1) + 'h', x0 - 4, chartTop  + 5);

  if (n === 0) {
    ctx.font      = '11px Roboto';
    ctx.fillStyle = TEXT_LT;
    ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet — log more feeds', x0 + chartW / 2, chartTop + ML_CHART_H / 2);
  } else {
    const bStep = Math.floor(chartW / n);
    const bw    = Math.max(16, bStep - 10);

    for (let i = 0; i < n; i++) {
      const b  = shown[i];
      const bx = x0 + i * bStep + Math.floor((bStep - bw) / 2);

      const barH = Math.max(4, Math.round((b.avgSleepH / maxSleep) * ML_CHART_H));
      roundRect(ctx, bx, chartBot - barH, bw, barH, 2, BAR_ML);

      // Avg value just above the bar
      ctx.font      = '8px Roboto';
      ctx.fillStyle = TEXT_LT;
      ctx.textAlign = 'center';
      ctx.fillText(b.avgSleepH.toFixed(1) + 'h', bx + bw / 2, chartBot - barH - 4);

      // ml label below the axis
      ctx.font      = '9px Roboto';
      ctx.fillStyle = TEXT_LT;
      ctx.fillText(`${b.amountMl}ml`, bx + bw / 2, chartBot + 14);

      // sample count on second line
      ctx.font      = '8px Roboto';
      ctx.fillStyle = TEXT_LT;
      ctx.fillText(`n=${b.count}`, bx + bw / 2, chartBot + 26);
    }
  }

  // Bottom axis line
  ctx.strokeStyle = AXIS_LINE;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(x0, chartBot);
  ctx.lineTo(x0 + chartW, chartBot);
  ctx.stroke();

  // Footnote
  const totalFeeds = shown.reduce((s, b) => s + b.count, 0);
  ctx.font      = '8px Roboto';
  ctx.fillStyle = TEXT_LT;
  ctx.textAlign = 'left';
  ctx.fillText(
    `Based on ${totalFeeds} feeds over the last ${days} days`,
    PAD, chartBot + ML_XLBL_H + ML_NOTE_H - 4
  );

  return canvas.toBuffer('image/png');
}
