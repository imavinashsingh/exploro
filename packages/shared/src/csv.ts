/** Rows of an RFC 4180 CSV: quoted fields may hold commas, newlines and `""` for a quote. */
export function parseCsv(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let field = "";
  let quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (body[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}
