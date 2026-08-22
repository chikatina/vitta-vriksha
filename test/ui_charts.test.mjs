import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { h, icon, selectField, closeOpenMenus } from '../app/src/main/assets/www/js/ui.js';
import {
  donutChart, columnChart, lineSeriesChart, areaChart, barSeriesChart,
  barList, legend, sparkline, heatCalendar, bindChartZoom, bindChartSelect,
} from '../app/src/main/assets/www/js/charts.js';
import { brandMark } from '../app/src/main/assets/www/js/brand-mark.js';

describe('ui.js and brand-mark.js helpers', () => {
  it('escapes HTML strings safely with h()', () => {
    assert.equal(h('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(h("Alice & Bob's"), 'Alice &amp; Bob&#39;s');
    assert.equal(h(null), '');
    assert.equal(h(undefined), '');
  });

  it('renders Material Symbol icons', () => {
    const check = icon('check');
    assert.ok(check.includes('icon'));
    const unknown = icon('non_existent_icon');
    assert.ok(unknown.includes('icon'));
  });

  it('renders brand mark image', () => {
    const mark = brandMark();
    assert.ok(mark.includes('images/vittvriksha.png'));
    assert.ok(mark.includes('brand-mark'));
  });

  it('maintains 9XX level z-index for dropdown menus and places lock overlay at 1000', async () => {
    const fs = await import('node:fs/promises');
    const css = await fs.readFile('app/src/main/assets/www/css/style.css', 'utf-8');
    assert.ok(css.includes('--z-overlay: 1000;'), 'overlay screen must be at 1000');
    assert.ok(css.includes('--z-scrim: 500;'), 'scrim must be at 500');
    assert.ok(css.includes('--z-dialog: 700;'), 'dialog must be at 700');
    assert.ok(css.includes('--z-menu-scrim: 990;'), 'menu scrim must be at 990');
    assert.ok(css.includes('--z-menu: 999;'), 'menu must be at 999');
    assert.ok(css.includes('z-index: var(--z-menu);'), 'menu selector must use --z-menu');
    assert.ok(css.includes('z-index: var(--z-menu-scrim);'), 'menu-scrim must use --z-menu-scrim');
  });

  it('defines .sticky-header with position: sticky and edge-to-edge negative margins', async () => {
    const fs = await import('node:fs/promises');
    const css = await fs.readFile('app/src/main/assets/www/css/style.css', 'utf-8');
    assert.ok(css.includes('.sticky-header {'), 'sticky-header rule must exist');
    assert.ok(css.includes('position: sticky;'), 'sticky-header must be sticky');
    assert.ok(css.includes('top: 0;'), 'sticky-header must stick to top');
    assert.ok(css.includes('z-index: 3;'), 'sticky-header must have appropriate z-index');
    assert.ok(css.includes('margin-left: calc(var(--gap-4) * -1);'), 'sticky-header must extend edge-to-edge on left');
    assert.ok(css.includes('margin-right: calc(var(--gap-4) * -1);'), 'sticky-header must extend edge-to-edge on right');
  });

  it('renders selectField with accessible attributes and closes open menus cleanly', () => {
    const html = selectField({
      key: 'type',
      label: 'Type',
      value: 'Expense',
      options: ['Expense', 'Income', 'Investment'],
    });
    assert.ok(html.includes('select-button'));
    assert.ok(html.includes('aria-haspopup="listbox"'));
    assert.ok(html.includes('aria-expanded="false"'));

    // Verify closeOpenMenus executes safely
    assert.doesNotThrow(() => closeOpenMenus());
  });

  it('routes saveFile through AndroidBridge when available', async () => {
    const { saveFile } = await import('../app/src/main/assets/www/js/ui.js');
    let captured = null;
    globalThis.AndroidBridge = {
      saveFile(name, mime, b64) {
        captured = { name, mime, b64 };
        return JSON.stringify({ success: true, filename: name, path: `Downloads/${name}` });
      },
    };

    const res = saveFile('vitta-vriksha-2026-08-17.vittavriksha', 'encrypted-payload-data', 'application/octet-stream');
    assert.equal(res.success, true);
    assert.equal(res.filename, 'vitta-vriksha-2026-08-17.vittavriksha');
    assert.equal(res.path, 'Downloads/vitta-vriksha-2026-08-17.vittavriksha');
    assert.equal(captured.name, 'vitta-vriksha-2026-08-17.vittavriksha');
    assert.equal(captured.mime, 'application/octet-stream');
    assert.ok(captured.b64.length > 0);

    delete globalThis.AndroidBridge;
  });
});

describe('charts.js SVG chart components', () => {
  it('renders donutChart with data or empty fallback', () => {
    const empty = donutChart([]);
    assert.ok(empty.includes('Nothing to chart yet'));

    const donut = donutChart([
      { label: 'Food', value: 3000, color: '#F87171' },
      { label: 'Rent', value: 15000, color: '#60A5FA' },
    ], { centerLabel: 'Total', centerValue: '₹18,000', selectable: true });
    assert.ok(donut.includes('<svg'));
    assert.ok(donut.includes('Food'));
    assert.ok(donut.includes('Rent'));
  });

  it('renders columnChart and sparkline', () => {
    const col = columnChart([
      { income: 5000, expense: 3000, label: 'Jan' },
      { income: 6000, expense: 4000, label: 'Feb' },
    ]);
    assert.ok(col.includes('<svg'));

    const spark = sparkline([10, 20, 15, 30]);
    assert.ok(spark.includes('<svg'));
  });

  it('renders lineSeriesChart and areaChart', () => {
    const line = lineSeriesChart(['Jan', 'Feb'], [
      { label: 'Trend', values: [100, 150], color: '#818CF8' },
    ]);
    assert.ok(line.includes('<svg'));

    const points = [
      { label: 'Jan', value: 100 },
      { label: 'Feb', value: 150 },
    ];
    const area = areaChart(points, { color: '#F472B6' });
    assert.ok(area.includes('<svg'));
  });

  it('renders barSeriesChart and barList', () => {
    const series = [
      { label: 'Expenses', values: [100, 200], color: '#EF4444' },
      { label: 'Income', values: [300, 400], color: '#10B981' },
    ];
    const chart = barSeriesChart(['M1', 'M2'], series, { stacked: true });
    assert.ok(chart.includes('<svg'));

    const list = barList([
      { key: 'cat1', label: 'Groceries', value: 4000, color: '#10B981', formatted: '₹4,000' },
      { key: 'cat2', label: 'Utilities', value: 2000, color: '#3B82F6', formatted: '₹2,000' },
    ], { selectable: true });
    assert.ok(list.includes('Groceries'));
    assert.ok(list.includes('Utilities'));

    const leg = legend(series);
    assert.ok(leg.includes('Expenses'));
    assert.ok(leg.includes('Income'));
  });
});

describe('charts.js X-axis label overlap prevention', () => {
  const months12 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const values12 = [10, 20, 15, 30, 25, 35, 40, 30, 45, 50, 55, 60];

  it('prevents X-axis label overlap in barSeriesChart for 12 monthly buckets', () => {
    const series = [{ label: 'Spending', values: values12, color: '#EF4444' }];
    const chart = barSeriesChart(months12, series, { keys: months12 });

    // Count rendered <text tags in the SVG output
    const textMatches = chart.match(/<text\b[^>]*>(.*?)<\/text>/g) || [];
    // With 12 buckets and default maxLabels = 6, stride is Math.ceil(12/6) = 2 -> 6 labels
    assert.equal(textMatches.length, 6);

    // Checks that even-index months are rendered and odd-index months are omitted from <text>
    assert.ok(chart.includes('>Jan<'));
    assert.ok(chart.includes('>Mar<'));
    assert.ok(chart.includes('>May<'));
    assert.ok(chart.includes('>Jul<'));
    assert.ok(chart.includes('>Sep<'));
    assert.ok(chart.includes('>Nov<'));

    // Hit targets and tooltips should still exist for ALL 12 months
    const hitMatches = chart.match(/class="chart-hit"/g) || [];
    assert.equal(hitMatches.length, 12);
  });

  it('renders all labels in barSeriesChart when count <= maxLabels', () => {
    const months6 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const values6 = [10, 20, 15, 30, 25, 35];
    const series = [{ label: 'Spending', values: values6, color: '#EF4444' }];
    const chart = barSeriesChart(months6, series);

    const textMatches = chart.match(/<text\b[^>]*>(.*?)<\/text>/g) || [];
    assert.equal(textMatches.length, 6);
    for (const m of months6) {
      assert.ok(chart.includes(`>${m}<`));
    }
  });

  it('honors custom maxLabels option in barSeriesChart', () => {
    const series = [{ label: 'Spending', values: values12, color: '#EF4444' }];
    // maxLabels = 4 -> stride is Math.ceil(12/4) = 3 -> 4 labels: index 0, 3, 6, 9
    const chart = barSeriesChart(months12, series, { maxLabels: 4 });

    const textMatches = chart.match(/<text\b[^>]*>(.*?)<\/text>/g) || [];
    assert.equal(textMatches.length, 4);
    assert.ok(chart.includes('>Jan<'));
    assert.ok(chart.includes('>Apr<'));
    assert.ok(chart.includes('>Jul<'));
    assert.ok(chart.includes('>Oct<'));
  });

  it('prevents X-axis label overlap in lineSeriesChart for multi-month ranges', () => {
    const months24 = Array.from({ length: 24 }, (_, i) => `M${i + 1}`);
    const values24 = Array.from({ length: 24 }, (_, i) => (i + 1) * 10);
    const series = [{ label: 'Net Worth', values: values24, color: '#10B981' }];

    const chart = lineSeriesChart(months24, series, { keys: months24 });
    const textMatches = chart.match(/<text\b[^>]*>(.*?)<\/text>/g) || [];

    // With 24 buckets and default maxLabels = 6, stride is Math.ceil(24/6) = 4 -> 6 labels
    assert.equal(textMatches.length, 6);
    assert.ok(chart.includes('>M1<'));
    assert.ok(chart.includes('>M5<'));
    assert.ok(chart.includes('>M9<'));
    assert.ok(chart.includes('>M13<'));
    assert.ok(chart.includes('>M17<'));
    assert.ok(chart.includes('>M21<'));

    // Hit targets and polyline points remain intact for all 24 buckets
    const hitMatches = chart.match(/class="chart-hit"/g) || [];
    assert.equal(hitMatches.length, 24);
  });

  it('prevents X-axis label overlap in columnChart for 12 monthly points', () => {
    const points12 = months12.map((m, i) => ({
      label: m,
      income: 5000 + i * 200,
      expense: 3000 + i * 150,
    }));

    const chart = columnChart(points12);
    const textMatches = chart.match(/<text\b[^>]*>(.*?)<\/text>/g) || [];
    // With 12 points and default maxLabels = 6, stride = 2 -> 6 labels
    assert.equal(textMatches.length, 6);
    assert.ok(chart.includes('>Jan<'));
    assert.ok(chart.includes('>Mar<'));
    assert.ok(chart.includes('>May<'));
    assert.ok(chart.includes('>Jul<'));
    assert.ok(chart.includes('>Sep<'));
    assert.ok(chart.includes('>Nov<'));
  });
});

describe('charts.js pinch-to-zoom and gesture interaction', () => {
  function createMockChartNode() {
    const listeners = new Map();
    const svg = {
      style: { transform: '', transformOrigin: '', transition: '' },
    };
    const node = {
      clientWidth: 320,
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        has(c) { return this.classes.has(c); },
      },
      querySelector(selector) {
        if (selector === 'svg') return svg;
        return null;
      },
      appendChild() {},
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      removeEventListener(event, fn) {
        if (!listeners.has(event)) return;
        const list = listeners.get(event).filter((f) => f !== fn);
        listeners.set(event, list);
      },
      trigger(event, data = {}) {
        const list = listeners.get(event) || [];
        for (const fn of list) fn({ preventDefault() {}, stopPropagation() {}, ...data });
      },
    };
    return { node, svg };
  }

  it('initializes chart as zoomable and handles 2-finger pinch gestures', () => {
    const { node, svg } = createMockChartNode();
    let recordedScale = 1;
    const zoom = bindChartZoom(node, {
      onZoom: (s) => { recordedScale = s; },
    });

    assert.ok(node.classList.has('chart-zoomable'));
    assert.equal(zoom.getScale(), 1);

    // Simulate 2-finger touchstart (distance = 100px)
    node.trigger('touchstart', {
      touches: [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ],
    });

    // Simulate 2-finger touchmove pinch open (distance = 200px -> 2.0x zoom)
    node.trigger('touchmove', {
      touches: [
        { clientX: 50, clientY: 100 },
        { clientX: 250, clientY: 100 },
      ],
    });

    assert.equal(zoom.getScale(), 2);
    assert.equal(recordedScale, 2);
    assert.ok(svg.style.transform.includes('scaleX(2)'));

    // Reset zoom
    zoom.reset();
    assert.equal(zoom.getScale(), 1);
    assert.equal(svg.style.transform, '');

    zoom.destroy();
  });

  it('handles mouse wheel and trackpad pinch zoom', () => {
    const { node, svg } = createMockChartNode();
    const zoom = bindChartZoom(node);

    // Simulate Ctrl + Wheel zoom in
    node.trigger('wheel', {
      ctrlKey: true,
      deltaY: -100,
    });

    assert.ok(zoom.getScale() > 1);
    assert.ok(svg.style.transform.includes('scaleX'));

    zoom.reset();
    assert.equal(zoom.getScale(), 1);
    zoom.destroy();
  });
});
