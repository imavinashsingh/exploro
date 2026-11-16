import { describe, expect, it } from "vite-plus/test";

import { addProjectSites } from "./ProjectSitesSettings.logic";

describe("addProjectSites", () => {
  it.each([
    [[], "https://shop.test/login?x=1", ["https://shop.test"]],
    [[], "staging.shop.test", ["https://staging.shop.test"]],
    [[], "http://localhost:3000, shop.test", ["http://localhost:3000", "https://shop.test"]],
    [["https://shop.test"], "shop.test/cart", null],
    [[], "ftp://shop.test", null],
    [[], "   ", null],
  ] as const)("%j + %j", (sites, draft, expected) => {
    expect(addProjectSites(sites, draft)).toEqual(expected);
  });
});
