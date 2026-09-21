// Minimal PDF writer for the hours report. Helvetica only — no extra deps.
const PAGE_W = 792; // landscape letter
const PAGE_H = 612;
const MARGIN = 36;
const LINE = 12;

function pdfEscape(s) {
  return String(s ?? '')
    .replace(/[\u2013\u2014\u00B7\u2022]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 3))}...`;
}

function fmtHours(h) {
  return Number(h || 0).toFixed(2);
}

function fmtWhen(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function text(x, y, s, { size = 9, bold = false } = {}) {
  const font = bold ? 'F2' : 'F1';
  return `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfEscape(s)}) Tj ET\n`;
}

const NAVY = [0.059, 0.153, 0.251];
const BAND = [0.906, 0.929, 0.957];
const RULE = [0.78, 0.82, 0.86];

function fillRect(x, y, w, h, rgb = BAND) {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 0 0 rg\n`;
}

function hline(x1, x2, y, { width = 0.7, rgb = RULE } = {}) {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]} RG ${width} w ${x1.toFixed(1)} ${y.toFixed(1)} m ${x2.toFixed(1)} ${y.toFixed(1)} l S 0 0 0 RG 0 0 0 rg\n`;
}

function assemblePdf(pageStreams) {
  const objs = [null];
  const add = (body) => {
    objs.push(body);
    return objs.length - 1;
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const contentIds = pageStreams.map((stream) => {
    const bytes = Buffer.byteLength(stream, 'utf8');
    return add(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`);
  });

  const pagesId = add('placeholder');
  const pageIds = contentIds.map((cid) => add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
    + `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> `
    + `/Contents ${cid} 0 R >>`
  ));
  objs[pagesId] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'utf8');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objs.length}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer << /Size ${objs.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

export function buildHoursPdf(report) {
  const pages = [];
  let ops = '';
  let y = PAGE_H - MARGIN;
  let pageNo = 1;

  const header = () => {
    ops += text(MARGIN, y, 'Constructors911 Field  -  Hours report', { size: 14, bold: true });
    y -= 16;
    ops += text(MARGIN, y, `${fmtDay(report.from)} - ${fmtDay(report.to)}   Total ${fmtHours(report.totals.totalHours)} hrs   Regular ${fmtHours(report.totals.regularHours)}   OT ${fmtHours(report.totals.overtimeHours)}`, { size: 9 });
    y -= 10;
    ops += text(PAGE_W - MARGIN - 80, PAGE_H - MARGIN, `Page ${pageNo}`, { size: 8 });
    y -= 6;
    ops += hline(MARGIN, PAGE_W - MARGIN, y, { width: 1, rgb: NAVY });
    y -= 16;
  };

  const flush = () => {
    pages.push(ops);
    ops = '';
    y = PAGE_H - MARGIN;
    pageNo += 1;
  };

  const need = (h = LINE) => {
    if (y - h < MARGIN + 10) {
      flush();
      header();
    }
  };

  const punchCols = [
    { x: MARGIN, w: 86, key: 'day' },
    { x: MARGIN + 86, w: 150, key: 'job' },
    { x: MARGIN + 236, w: 110, key: 'activity' },
    { x: MARGIN + 346, w: 150, key: 'inout' },
    { x: MARGIN + 496, w: 50, key: 'hours' },
    { x: MARGIN + 546, w: 90, key: 'pushed' },
  ];

  header();

  const users = report.users || [];
  users.forEach((user, index) => {
    const minBlock = 56;
    if (index > 0) {
      y -= 8;
      need(minBlock + 18);
      ops += hline(MARGIN, PAGE_W - MARGIN, y, { width: 1.6, rgb: NAVY });
      y -= 18;
    } else {
      need(minBlock);
    }

    const bandH = 30;
    ops += fillRect(MARGIN - 2, y - 18, PAGE_W - 2 * MARGIN + 4, bandH);
    ops += text(MARGIN + 4, y, user.userName || 'Unknown', { size: 13, bold: true });
    y -= 14;
    ops += text(MARGIN + 4, y, `${fmtHours(user.totalHours)} hrs    Regular ${fmtHours(user.regularHours)}    OT ${fmtHours(user.overtimeHours)}`, { size: 9 });
    y -= 20;

    need(LINE);
    const heads = ['Day', 'Job', 'Activity', 'In -> Out', 'Hours', 'Pushed to JT'];
    punchCols.forEach((c, i) => {
      ops += text(c.x, y, heads[i], { size: 8, bold: true });
    });
    y -= 4;
    ops += hline(MARGIN, PAGE_W - MARGIN, y, { width: 0.6 });
    y -= LINE;

    for (const day of user.days) {
      for (const p of day.punches) {
        need(LINE);
        const pushed = p.pushed ? 'Pushed' : (p.status === 'open' ? 'Open' : 'Not pushed');
        const cells = [
          fmtDay(day.date),
          clip(p.jobName, 28),
          clip(p.activity || '-', 20),
          p.entryKind === 'daily'
            ? 'Daily total'
            : `${fmtWhen(p.startedAt)} -> ${p.endedAt ? fmtWhen(p.endedAt) : 'open'}${p.breakMinutes ? ` (${p.breakMinutes}m brk)` : ''}`,
          p.endedAt ? fmtHours(p.hours) : '-',
          p.jtTimeEntryId ? `${pushed} ${p.jtTimeEntryId}` : pushed,
        ];
        punchCols.forEach((c, i) => {
          ops += text(c.x, y, cells[i], { size: 8 });
        });
        y -= LINE;
      }
      need(LINE);
      ops += text(punchCols[0].x, y, `Day total  ${fmtDay(day.date)}${day.lunchMinutes > 0 ? '  (30 min lunch out)' : ''}`, { size: 8, bold: true });
      ops += text(punchCols[4].x, y, fmtHours(day.hours), { size: 8, bold: true });
      y -= LINE + 2;
    }

    need(20);
    ops += text(MARGIN, y, 'Weekly overtime (Sun-Sat)', { size: 10, bold: true });
    y -= 14;
    const weekHeads = ['Week', 'Hours', 'Regular', 'Overtime'];
    const weekXs = [MARGIN, MARGIN + 220, MARGIN + 300, MARGIN + 390];
    weekHeads.forEach((h, i) => { ops += text(weekXs[i], y, h, { size: 8, bold: true }); });
    y -= LINE;
    for (const w of user.weeks) {
      need(LINE);
      const label = `${fmtDay(w.weekStart)} - ${fmtDay(w.weekEnd)}${w.partial ? '  (partial)' : ''}`;
      ops += text(weekXs[0], y, label, { size: 8 });
      ops += text(weekXs[1], y, fmtHours(w.hours), { size: 8 });
      ops += text(weekXs[2], y, fmtHours(w.regularHours), { size: 8 });
      ops += text(weekXs[3], y, fmtHours(w.overtimeHours), { size: 8, bold: w.overtimeHours > 0 });
      y -= LINE;
    }
    y -= 10;
  });

  if (!report.users?.length) {
    ops += text(MARGIN, y, 'No punches in this range.', { size: 10 });
  }

  flush();
  return assemblePdf(pages);
}
