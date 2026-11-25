import { describe, expect, it } from "@effect/vitest";

import { providedSecretsInOrder } from "./providedSecrets.ts";

describe("providedSecretsInOrder", () => {
  it.each([
    ["On saucedemo, check locked_out_user. The password is secret_sauce.", ["secret_sauce"]],
    ["Use standard_user with password secret_sauce and check login", ["secret_sauce"]],
    ['Password: "hunter2!" and PWD=abc123', ["hunter2!", "abc123"]],
    ["Check that a wrong password is rejected", []],
    ["Leave the password field empty", []],
    ["The password is <provided password>", []],
  ])("%s", (text, secrets) => {
    expect(providedSecretsInOrder([text])).toEqual(secrets);
  });

  // A saved suite types `{{secret:N}}`, so a later or repeated password must not renumber it.
  it("numbers each password once, in the order the user gave them", () => {
    expect(
      providedSecretsInOrder([
        "password is a_1",
        "password is longer_2 and password is a_1",
        "password is b_3",
      ]),
    ).toEqual(["a_1", "longer_2", "b_3"]);
  });
});
