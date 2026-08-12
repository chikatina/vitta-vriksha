/*
 * SVG charts, no dependencies.
 *
 * Each function returns an HTML string so views can compose it into their own markup.
 * Colours come from the caller, since category colours live in the database.
 *
 * The charts are tappable. Anything that draws over a run of buckets also draws one
 * invisible full-height target per bucket, carrying the bucket's key in `data-bucket`, and
 * `bindChartSelect` turns a tap on one into a call with that key. That is what makes a
 * drilldown possible: the chart does not know what a month means, it only reports which one
 * was touched, and the view decides what to do about it. Full-height targets rather than
 * the bars themselves, because a bar for a quiet week is four pixels tall and nobody can
 * hit it with a thumb.
 */

import { h } from './ui.js';

let gradientSeq = 0;

/** The band behind the chosen bucket, drawn under the bars so it reads as a backdrop. */
function selectionBand({
  count, height, selected, width = null,
}) {
  if (!(selected >= 0) || selected >= count) return '';
  const slot = (width || 100) / count;
  const unit = width ? '' : '%';
  return `<rect x="${slot * selected}${unit}" y="0" width="${slot}${unit}" height="${height}"
                rx="4" fill="var(--accent)" opacity="0.12" />`;
}

/**
 * Invisible tap targets, one per bucket, drawn over everything else.
 *
 * `keys` are what comes back when one is tapped. Without them a chart is decoration, which
 * is fine, and the targets are left out entirely rather than swallowing taps for nothing.
 * Drawn last on purpose: a bar painted over its own target takes the tap and the target
 * never sees it.
 */
function hitTargets({
  keys, count, height, titles = [], width = null,
}) {
  if (!keys || !keys.length) return '';

  const slot = (width || 100) / count;
  const unit = width ? '' : '%';

  return keys.slice(0, count).map((key, i) => `
    <rect class="chart-hit" data-bucket="${h(key)}" data-index="${i}"
          x="${slot * i}${unit}" y="0" width="${slot}${unit}" height="${height}"
          fill="transparent">${titles[i] ? `<title>${h(titles[i])}</title>` : ''}</rect>`).join('');
}

/**
 * Enables pinch-to-zoom and horizontal pan on an SVG chart container.
 *
 * Supports:
 * - Two-finger pinch to zoom in/out (1x to 4x)
 * - One-finger horizontal drag to pan across the timeline when zoomed in
 * - Double tap to reset zoom back to 1x
 * - Trackpad / mouse wheel zooming (Ctrl + wheel or trackpad pinch)
 * - Click suppression when dragging/panning
 */
export function bindChartZoom(root, { minScale = 1, maxScale = 4, onZoom = null } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};

  const svg = root.querySelector ? root.querySelector('svg') : null;
  if (!svg) return () => {};

  if (root.classList && typeof root.classList.add === 'function') {
    root.classList.add('chart-zoomable');
  }

  let scale = 1;
  let panX = 0;
  let startDist = 0;
  let startScale = 1;
  let startPanX = 0;
  let startTouchX = 0;
  let lastTapTime = 0;
  let isPanning = false;
  let moved = false;

  let indicator = root.querySelector ? root.querySelector('.chart-zoom-pill') : null;
  if (!indicator && typeof document !== 'undefined' && document.createElement) {
    indicator = document.createElement('button');
    indicator.type = 'button';
    indicator.className = 'chart-zoom-pill';
    indicator.setAttribute('aria-label', 'Reset chart zoom');
    indicator.style.display = 'none';
    root.appendChild(indicator);
    indicator.addEventListener('click', (e) => {
      e.stopPropagation();
      resetZoom(true);
    });
  }

  function updateTransform(animate = false) {
    if (svg.style) {
      if (animate) {
        svg.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
        setTimeout(() => { if (svg.style) svg.style.transition = ''; }, 260);
      } else {
        svg.style.transition = '';
      }

      if (scale <= 1.02) {
        scale = 1;
        panX = 0;
        svg.style.transform = '';
        svg.style.transformOrigin = '';
        if (indicator && indicator.style) indicator.style.display = 'none';
      } else {
        const width = root.clientWidth || 320;
        const maxPan = ((scale - 1) / 2) * width;
        panX = Math.max(-maxPan, Math.min(maxPan, panX));

        svg.style.transform = `scaleX(${scale}) translateX(${panX / scale}px)`;
        svg.style.transformOrigin = 'center center';
        if (indicator) {
          indicator.textContent = `${scale.toFixed(1)}× Reset`;
          if (indicator.style) indicator.style.display = 'inline-flex';
        }
      }
    }

    if (typeof onZoom === 'function') onZoom(scale, panX);
  }

  function resetZoom(animate = true) {
    scale = 1;
    panX = 0;
    updateTransform(animate);
  }

  function getDistance(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(e) {
    if (!e.touches) return;
    if (e.touches.length === 2) {
      startDist = getDistance(e.touches[0], e.touches[1]);
      startScale = scale;
      startPanX = panX;
      moved = true;
    } else if (e.touches.length === 1) {
      startTouchX = e.touches[0].clientX;
      startPanX = panX;
      moved = false;
      isPanning = scale > 1.05;

      const now = Date.now();
      if (now - lastTapTime < 300) {
        if (scale > 1.1) resetZoom(true);
        else {
          scale = 2;
          panX = 0;
          updateTransform(true);
        }
        lastTapTime = 0;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return;
      }
      lastTapTime = now;
    }
  }

  function onTouchMove(e) {
    if (!e.touches) return;
    if (e.touches.length === 2 && startDist > 0) {
      const currentDist = getDistance(e.touches[0], e.touches[1]);
      const factor = currentDist / startDist;
      scale = Math.max(minScale, Math.min(maxScale, startScale * factor));
      updateTransform(false);
      if (typeof e.preventDefault === 'function') e.preventDefault();
    } else if (e.touches.length === 1 && isPanning) {
      const dx = e.touches[0].clientX - startTouchX;
      if (Math.abs(dx) > 4) moved = true;
      panX = startPanX + dx;
      updateTransform(false);
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (!e.touches || e.touches.length === 0) {
      startDist = 0;
      isPanning = false;
      if (scale <= 1.05) {
        resetZoom(true);
      } else {
        updateTransform(false);
      }
    } else if (e.touches.length === 1) {
      startDist = 0;
      startTouchX = e.touches[0].clientX;
      startPanX = panX;
    }
  }

  function onWheel(e) {
    if (e.ctrlKey || (e.deltaY !== undefined && Math.abs(e.deltaY) < 50)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      const delta = -(e.deltaY || 0) * 0.01;
      const prevScale = scale;
      scale = Math.max(minScale, Math.min(maxScale, scale + delta));
      if (scale !== prevScale) {
        updateTransform(false);
      }
    }
  }

  root.addEventListener('touchstart', onTouchStart, { passive: false });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd);
  root.addEventListener('touchcancel', onTouchEnd);
  root.addEventListener('wheel', onWheel, { passive: false });

  // Suppress click if moved during panning/pinching
  root.addEventListener('click', (e) => {
    if (moved) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      moved = false;
    }
  }, true);

  return {
    reset: resetZoom,
    getScale: () => scale,
    getPan: () => panX,
    destroy: () => {
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchEnd);
      root.removeEventListener('wheel', onWheel);
    },
  };
}

/**
 * Wires every tap target under `root` to one handler and attaches pinch-to-zoom.
 *
 * One listener on the container rather than one per target: a daily chart has ninety of
 * them, and they are replaced every time the period changes.
 */
export function bindChartSelect(root, handler, { zoomable = true } = {}) {
  if (!root) return;
  root.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target.closest('[data-bucket]') : null;
    if (!target) return;
    handler(target.dataset.bucket, Number(target.dataset.index));
  });

  // Enable pinch-to-zoom for timeline charts (bar, line, column, area)
  if (zoomable && !root.querySelector?.('.chart-legend')) {
    bindChartZoom(root);
  }
}

/**
 * Donut with a legend. Slices are { label, value, color }.
 */
export function donutChart(slices, {
  size = 150, thickness = 22, centerLabel = '', centerValue = '', selectable = false,
} = {}) {
  const usable = slices.filter((s) => Number(s.value) > 0);
  const total = usable.reduce((sum, s) => sum + Number(s.value), 0);

  if (!total) {
    return `<div class="caption" style="text-align:center;padding:24px 0">Nothing to chart yet.</div>`;
  }

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const arcs = usable.map((slice) => {
    const fraction = Number(slice.value) / total;
    // A hairline gap between slices reads as separation without a stroke.
    const length = Math.max(0, fraction * circumference - 2);
    const arc = `
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}"
        ${selectable ? `class="chart-hit" data-bucket="${h(slice.key ?? slice.label)}"` : ''}
        fill="none" stroke="${h(slice.color)}" stroke-width="${thickness}"
        stroke-dasharray="${length} ${circumference - length}"
        stroke-dashoffset="${-offset * circumference}" stroke-linecap="round">
        <title>${h(slice.label)}: ${h(slice.formatted ?? Math.round(Number(slice.value)))}</title>
      </circle>`;
    offset += fraction;
    return arc;
  }).join('');

  // A legend row is the easier target of the two, so when the chart leads somewhere the
  // rows lead there as well.
  const legend = usable.map((slice) => {
    const body = `
      <span class="legend-dot" style="background:${h(slice.color)}"></span>
      <span class="legend-label">${h(slice.label)}</span>
      <span class="legend-value">${((Number(slice.value) / total) * 100).toFixed(0)}%</span>`;
    return selectable
      ? `<button type="button" class="legend-row legend-row-tappable"
                 data-bucket="${h(slice.key ?? slice.label)}">${body}</button>`
      : `<div class="legend-row">${body}</div>`;
  }).join('');

  return `
    <div class="row" style="gap:20px;flex-wrap:wrap;justify-content:center">
      <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"
             style="transform:rotate(-90deg)" role="img" aria-label="Allocation by share">
          ${arcs}
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;
                    align-items:center;justify-content:center;pointer-events:none;text-align:center">
          ${centerLabel ? `<span class="overline">${h(centerLabel)}</span>` : ''}
          ${centerValue ? `<span class="title numeric">${h(centerValue)}</span>` : ''}
        </div>
      </div>
      <div class="chart-legend">${legend}</div>
    </div>`;
}

/**
 * Ranked horizontal bars. Items are { label, value, formatted, color, icon }.
 */
export function barList(items, { max, selectable = false } = {}) {
  if (!items.length) {
    return `<div class="caption" style="text-align:center;padding:20px 0">Nothing to chart yet.</div>`;
  }

  const ceiling = max || Math.max(...items.map((i) => Number(i.value) || 0), 1);

  return `<div class="bar-list">${items.map((item) => {
    const width = Math.min(100, Math.max(3, (Number(item.value) / ceiling) * 100));
    const body = `
      <span class="bar-head">
        <span class="legend-label">${h(item.label)}</span>
        <span class="legend-value">${h(item.formatted ?? item.value)}</span>
      </span>
      <span class="bar-track">
        <span class="bar-fill" style="width:${width}%;background:${h(item.color || 'var(--accent)')}"></span>
      </span>
      ${item.sub ? `<span class="caption">${h(item.sub)}</span>` : ''}`;

    return selectable
      ? `<button type="button" class="bar-row bar-row-tappable"
                 data-bucket="${h(item.key ?? item.label)}">${body}</button>`
      : `<div class="bar-row">${body}</div>`;
  }).join('')}</div>`;
}

/**
 * Paired income and expense columns, one group per month. Points are
 * { label, income, expense }, oldest first.
 */
export function columnChart(points, {
  height = 132, incomeColor = 'var(--income)', expenseColor = 'var(--expense)', maxLabels = 6,
} = {}) {
  if (!points.length) {
    return `<div class="caption" style="text-align:center;padding:20px 0">Nothing to chart yet.</div>`;
  }

  const ceiling = Math.max(...points.flatMap((p) => [p.income || 0, p.expense || 0]), 1);
  const columnWidth = 100 / points.length;
  const stride = Math.max(1, Math.ceil(points.length / maxLabels));

  const groups = points.map((point, index) => {
    const left = index * columnWidth;
    const bar = (value, color, offset) => {
      const barHeight = Math.max(2, ((value || 0) / ceiling) * (height - 22));
      return `<rect x="${left + columnWidth * offset}%" y="${height - 18 - barHeight}"
                    width="${columnWidth * 0.3}%" height="${barHeight}"
                    rx="3" fill="${color}" />`;
    };
    const showLabel = Boolean(point.label) && (index % stride === 0);
    const labelText = showLabel
      ? `\n      <text x="${left + columnWidth / 2}%" y="${height - 4}" text-anchor="middle"
            font-size="10" fill="var(--on-surface-faint)">${h(point.label)}</text>`
      : '';
    return `
      ${bar(point.income, incomeColor, 0.16)}
      ${bar(point.expense, expenseColor, 0.54)}${labelText}`;
  }).join('');

  return `
    <svg width="100%" height="${height}" role="img" aria-label="Income against spending by month">
      ${groups}
    </svg>`;
}

const ROLE_COLORS = {
  income: 'var(--income)',
  expense: 'var(--expense)',
  investment: 'var(--investment)',
  invested: 'var(--investment)',
  accent: 'var(--accent)',
};

const PALETTE = ['#3B82F6', '#8B5CF6', '#14B8A6', '#F59E0B', '#EC4899', '#06B6D4', '#94A3B8'];

/** A series carries either an explicit colour or a semantic role. */
function seriesColor(series, index) {
  return series.color || ROLE_COLORS[series.role] || PALETTE[index % PALETTE.length];
}

/** Shared key for the multi-series charts. */
export function legend(series) {
  return `<div class="row" style="flex-wrap:wrap;gap:10px 14px">${series.map((s, i) => `
    <span class="row" style="gap:6px">
      <span class="legend-dot" style="background:${h(seriesColor(s, i))}"></span>
      <span class="caption">${h(s.label)}</span>
    </span>`).join('')}</div>`;
}

/**
 * Bars over time. Stacked when `stacked` is set, grouped side by side otherwise.
 *
 * `buckets` are the x labels and each series carries one value per bucket, which is the
 * shape the get_series backend action returns.
 */
export function barSeriesChart(buckets, series, {
  height = 160, stacked = false, format, keys = null, selected = -1, maxLabels = 6,
} = {}) {
  const usable = series.filter((s) => s.values.some((v) => v));
  if (!buckets.length || !usable.length) {
    return `<div class="caption" style="text-align:center;padding:24px 0">Nothing to chart yet.</div>`;
  }

  const axis = 20;
  const plot = height - axis;

  const ceiling = stacked
    ? Math.max(...buckets.map((_, i) => usable.reduce((sum, s) => sum + (s.values[i] || 0), 0)), 1)
    : Math.max(...usable.flatMap((s) => s.values), 1);

  const slot = 100 / buckets.length;
  const groupWidth = stacked ? slot * 0.46 : (slot * 0.7) / usable.length;
  const stride = Math.max(1, Math.ceil(buckets.length / maxLabels));

  const columns = buckets.map((label, i) => {
    let stackTop = plot;

    const bars = usable.map((s, si) => {
      const value = s.values[i] || 0;
      if (value <= 0) return '';

      const barHeight = Math.max(1.5, (value / ceiling) * (plot - 6));
      const x = stacked
        ? slot * i + slot * 0.27
        : slot * i + slot * 0.15 + groupWidth * si;

      const y = stacked ? (stackTop -= barHeight) : plot - barHeight;
      // Only the topmost segment of a stack gets rounded, so the stack reads as one bar.
      const radius = stacked && si !== usable.length - 1 ? 0 : 3;

      return `<rect x="${x}%" y="${y}" width="${groupWidth}%" height="${barHeight}"
                    rx="${radius}" fill="${seriesColor(s, si)}"><title>${h(s.label)}: ${
                      format ? h(format(value)) : Math.round(value)}</title></rect>`;
    }).join('');

    const showLabel = Boolean(label) && (i % stride === 0);
    const labelText = showLabel
      ? `\n      <text x="${slot * i + slot / 2}%" y="${height - 5}" text-anchor="middle"
            font-size="10" fill="var(--on-surface-faint)">${h(label)}</text>`
      : '';

    return `${bars}${labelText}`;
  }).join('');

  // What each period came to, for the tooltip a long press gives and for anybody reading
  // the markup with a screen reader.
  const titles = buckets.map((label, i) => {
    const total = usable.reduce((sum, s) => sum + (s.values[i] || 0), 0);
    return `${label}: ${format ? format(total) : Math.round(total)}`;
  });

  return `
    <svg width="100%" height="${height}" role="img" aria-label="Values by period">
      ${selectionBand({ count: buckets.length, height: plot, selected })}
      <line x1="0" y1="${plot}" x2="100%" y2="${plot}" stroke="var(--outline)" stroke-width="1"/>
      ${columns}
      ${hitTargets({
    keys, count: buckets.length, height: plot, titles,
  })}
    </svg>`;
}

/** One or more lines over the same buckets. */
export function lineSeriesChart(buckets, series, {
  height = 160, format, keys = null, selected = -1, maxLabels = 6,
} = {}) {
  const usable = series.filter((s) => s.values.some((v) => v));
  if (buckets.length < 2 || !usable.length) {
    return `<div class="caption" style="text-align:center;padding:24px 0">Not enough history to plot yet.</div>`;
  }

  const axis = 20;
  const plot = height - axis;
  const padX = 14;
  const width = 320;
  const stride = Math.max(1, Math.ceil(buckets.length / maxLabels));

  const values = usable.flatMap((s) => s.values);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const x = (i) => padX + (i / (buckets.length - 1)) * (width - padX * 2);
  const y = (v) => plot - 6 - ((v - min) / span) * (plot - 18);

  const lines = usable.map((s, si) => {
    const colour = seriesColor(s, si);
    const points = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const dots = s.values.map((v, i) =>
      `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${colour}"><title>${
        format ? h(format(v)) : Math.round(v)}</title></circle>`).join('');

    return `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="2.5"
                      stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const labels = buckets.map((label, i) => {
    if (!label || i % stride !== 0) return '';
    return `
    <text x="${x(i)}" y="${height - 5}" text-anchor="middle" font-size="10"
          fill="var(--on-surface-faint)">${h(label)}</text>`;
  }).join('');

  const titles = buckets.map((label, i) => {
    const parts = usable.map((s) => `${s.label} ${format ? format(s.values[i]) : Math.round(s.values[i])}`);
    return `${label}: ${parts.join(', ')}`;
  });

  return `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}"
         preserveAspectRatio="none" role="img" aria-label="Trend by period">
      ${selectionBand({
    count: buckets.length, height: plot, selected, width,
  })}
      <line x1="0" y1="${plot}" x2="${width}" y2="${plot}" stroke="var(--outline)" stroke-width="1"/>
      ${lines}
      ${labels}
      ${hitTargets({
    keys, count: buckets.length, height: plot, titles, width,
  })}
    </svg>`;
}

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * A month of days as a grid, shaded by how much each day cost.
 *
 * The one chart here that is not SVG, because it is a calendar: a grid of dated cells is
 * what CSS grid is for, and drawing it as SVG would mean positioning thirty-one numbers by
 * hand. Cells are { date, value } and any day the range does not include is simply absent,
 * so a part month renders as a part month.
 *
 * Days are tappable through the same `data-bucket` contract as the bar charts, so tapping
 * the seventeenth and tapping the bar for the seventeenth land in the same place.
 */
export function heatCalendar(cells, { format, selected = '', empty = 'Nothing spent in this period.' } = {}) {
  const days = (cells || []).filter((cell) => cell && cell.date);
  if (!days.length) {
    return `<div class="caption" style="text-align:center;padding:20px 0">${h(empty)}</div>`;
  }

  const max = Math.max(...days.map((cell) => Number(cell.value) || 0), 1);
  const first = days[0].date;
  // Monday-first, matching the week buckets the rest of the app groups by.
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first);
  const leading = parts
    ? (new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getDay() + 6) % 7
    : 0;

  const heads = WEEKDAY_INITIALS.map((letter, i) => `
    <span class="heat-head" aria-hidden="true" data-weekday="${i}">${letter}</span>`).join('');

  const blanks = Array.from({ length: leading }, () => '<span class="heat-blank"></span>').join('');

  const cellsHtml = days.map((cell) => {
    const value = Number(cell.value) || 0;
    const day = Number(String(cell.date).slice(8, 10));
    /*
     * A floor and a ceiling on the shade.
     *
     * The floor is so a day with something on it never looks like a day with nothing on it.
     * The ceiling is so the number stays readable: the accent at full strength is a solid
     * block in both appearances, and the date written on it disappears.
     */
    const weight = value > 0 ? 0.12 + (value / max) * 0.45 : 0;
    return `
      <button type="button" class="heat-cell ${value > 0 ? '' : 'is-quiet'} ${cell.date === selected ? 'is-selected' : ''}"
              data-bucket="${h(cell.date)}"
              style="--heat:${weight.toFixed(3)}"
              aria-label="${h(cell.date)}${value ? `, ${format ? format(value) : Math.round(value)}` : ', nothing'}">
        <span class="heat-day">${day}</span>
      </button>`;
  }).join('');

  return `
    <div class="heat-grid">${heads}${blanks}${cellsHtml}</div>`;
}

/**
 * A trend the width of a row, for a list rather than a card.
 *
 * No axis, no labels and no interaction: it exists to say "rising" or "steady" beside a
 * figure, and anything more would need the room a real chart gets.
 */
export function sparkline(values, { height = 28, width = 90, color = 'var(--accent)' } = {}) {
  const numbers = (values || []).map((value) => Number(value) || 0);
  if (numbers.length < 2) return '';

  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const span = max - min || 1;
  const x = (i) => (i / (numbers.length - 1)) * width;
  const y = (value) => height - 3 - ((value - min) / span) * (height - 6);

  const points = numbers.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const last = numbers[numbers.length - 1];

  return `
    <svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         aria-hidden="true">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${x(numbers.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2" fill="${color}" />
    </svg>`;
}

/**
 * Smoothed area curve for projections. Points are { label, value }, oldest first.
 */
export function areaChart(points, { height = 140, color = 'var(--accent)' } = {}) {
  if (points.length < 2) {
    return `<div class="caption" style="text-align:center;padding:20px 0">Not enough data to plot a curve.</div>`;
  }

  const width = 320;
  const padX = 6;
  const padY = 12;
  const values = points.map((p) => Number(p.value) || 0);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const x = (i) => padX + (i / (points.length - 1)) * (width - padX * 2);
  const y = (v) => height - padY - ((v - min) / span) * (height - padY * 2);

  let path = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < values.length; i += 1) {
    const midX = (x(i - 1) + x(i)) / 2;
    path += ` C ${midX} ${y(values[i - 1])}, ${midX} ${y(values[i])}, ${x(i)} ${y(values[i])}`;
  }

  gradientSeq += 1;
  const gradientId = `areaFill${gradientSeq}`;

  return `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}"
         preserveAspectRatio="none" role="img" aria-label="Projected growth">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
          <stop offset="100%" stop-color="${color}" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${path} L ${x(points.length - 1)} ${height} L ${x(0)} ${height} Z" fill="url(#${gradientId})" />
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    </svg>`;
}
