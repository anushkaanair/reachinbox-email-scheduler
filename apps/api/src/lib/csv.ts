/**
 * CSV output helpers. Cells starting with = + - @ (or a tab/CR) can be executed as formulas when the
 * file is opened in Excel/Sheets ("CSV injection"), and recipients control some of these values —
 * so every cell that starts that way gets a leading apostrophe.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;
