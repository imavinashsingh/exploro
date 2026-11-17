import { describe, expect, it } from "vite-plus/test";

import { parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  it.each([
    [
      "name,email\nann,a@x.test\n",
      [
        ["name", "email"],
        ["ann", "a@x.test"],
      ],
    ],
    [
      'name,note\r\n"Lee, Jo","said ""hi""\nthen left"',
      [
        ["name", "note"],
        ["Lee, Jo", 'said "hi"\nthen left'],
      ],
    ],
    [
      "﻿a,b\n\n,\n1,\n",
      [
        ["a", "b"],
        ["1", ""],
      ],
    ],
  ])("reads %j", (text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });
});
