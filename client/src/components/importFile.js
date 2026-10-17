import { parseCsv } from '../pages/BankFeed.jsx';

// Shared by the file imports (transactions, customers / vendors, chart of accounts).

/** Excel dates arrive as Date objects at UTC midnight. */
const cellValue = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? '');

/** Read a CSV or Excel (.xlsx) file into rows of cells, without blank rows. */
export async function readTableFile(f) {
  let rows;
  if (/\.xlsx$/i.test(f.name)) {
    const { readSheet } = await import('read-excel-file/browser');
    rows = (await readSheet(f)).map((r) => r.map(cellValue));
  } else if (/\.xls$/i.test(f.name)) {
    throw new Error('Older .xls files are not supported. In Excel, use File → Save As → Excel Workbook (.xlsx) or CSV.');
  } else {
    rows = parseCsv(await f.text());
  }
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) throw new Error('The file is empty');
  return rows;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Match file columns to fields by heading ({ key, aliases }), ignoring case, spaces and punctuation. */
export function autoMap(fields, header) {
  const used = new Set();
  const map = {};
  for (const f of fields) {
    const idx = header.findIndex((h, i) => !used.has(i) && f.aliases.some((a) => squash(a) === squash(h)));
    map[f.key] = idx;
    if (idx >= 0) used.add(idx);
  }
  return map;
}
