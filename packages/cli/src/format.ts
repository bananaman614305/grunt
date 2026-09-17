/** Small formatting helpers shared by the read-only commands. */

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** A minimal fixed-width table: one header row, then one row per record. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), header.length),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => padRight(cell, widths[i] ?? cell.length)).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
}

/** Renders a `[0, 1]` noul/confidence value as a percentage, or "n/a". */
export function formatProbability(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(0)}%`;
}
