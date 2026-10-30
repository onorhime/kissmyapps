/** Rows of objects to CSV, with a header from the first row's keys. */
export function toCsv(rows: Array<Record<string, string | number>>): Array<Array<string | number>> {
  if (!rows.length) return []
  const keys = Object.keys(rows[0])
  return [keys, ...rows.map((row) => keys.map((key) => row[key] ?? ''))]
}

/** CSV text. Cells that start like a formula are prefixed so spreadsheets keep them as text. */
export function csvText(rows: Array<Array<string | number>>): string {
  const escape = (value: string | number) => {
    let text = String(value)
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\n']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return rows.map((row) => row.map(escape).join(',')).join('\n')
}

/** Builds a CSV in the browser and saves it. */
export function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const blob = new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.replace(/[^\w.-]+/g, '-')
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
