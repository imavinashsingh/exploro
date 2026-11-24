import { expect, it } from "@effect/vitest";
import { memoryEnvironmentMatches, normalizeMemoryEnvironment } from "./memoryEnvironment.ts";

it.each([
  [" DEV ", "dev"],
  ["development", "dev"],
  ["production", "prod"],
  ["HTTPS://DEV.DVAPPLY.COM:443/path?q=1", "https://dev.dvapply.com"],
  [null, null],
  [undefined, null],
  ["", null],
])("normalizes environment %s", (input, expected) => {
  expect(normalizeMemoryEnvironment(input)).toBe(expected);
});

it.each([
  ["dev", "https://dev.dvapply.com", true],
  ["https://dev.dvapply.com", "dev", true],
  ["development", "https://dev.dvapply.com", true],
  ["staging", "https://dev.dvapply.com", false],
  ["dev", "https://staging.dvapply.com", false],
  ["qa", "https://qa.example.test", true],
  ["prod", "https://production.example.test", true],
  ["https://dev.one.test", "https://dev.two.test", false],
  [null, "staging", true],
  ["dev", null, true],
])("matches %s against %s", (requested, saved, expected) => {
  expect(memoryEnvironmentMatches(requested, saved)).toBe(expected);
});
