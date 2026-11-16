import { describe, expect, it } from "@effect/vitest";

import { hideProvidedSecrets, providedSecrets } from "./providedSecrets.ts";

describe("providedSecrets", () => {
  it.each([
    ["On saucedemo, check locked_out_user. The password is secret_sauce.", ["secret_sauce"]],
    ["Use standard_user with password secret_sauce and check login", ["secret_sauce"]],
    ['Password: "hunter2!" and PWD=abc123', ["hunter2!", "abc123"]],
    ["Check that a wrong password is rejected", []],
    ["Leave the password field empty", []],
    ["The password is <provided password>", []],
  ])("%s", (text, secrets) => {
    expect([...providedSecrets([text])].sort()).toEqual([...secrets].sort());
  });

  it("replaces every copy, longest secret first", () => {
    expect(
      hideProvidedSecrets("secret_sauce2 then secret_sauce", ["secret_sauce2", "secret_sauce"]),
    ).toBe("<provided password> then <provided password>");
  });
});
