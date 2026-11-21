import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectMemory from "./ProjectMemory.ts";
import * as ProjectMemoryAccess from "./ProjectMemoryAccess.ts";
import * as ProjectUnderstanding from "./ProjectUnderstanding.ts";

const shop = ProjectId.make("shop");
const off = ProjectId.make("off");
const navigationOnly = ProjectId.make("navigation-only");
const scratch = ProjectId.make("scratch");

const layer = ProjectMemoryAccess.layer.pipe(
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (projectId) => Effect.succeed(projectId === scratch),
    }),
  ),
  Layer.provide(
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [off]: { qaMemoryEnabled: false },
        [navigationOnly]: { qaMemoryEnabled: true },
      },
    }),
  ),
  Layer.provide(Layer.mock(ProjectMemory.ProjectMemory)({})),
  Layer.provide(Layer.mock(ProjectUnderstanding.ProjectUnderstanding)({})),
);

it.effect("gives memory only to projects that have it on", () =>
  Effect.gen(function* () {
    const access = yield* ProjectMemoryAccess.ProjectMemoryAccess;
    assert.isTrue(yield* access.hasMemory(shop));
    assert.isFalse(yield* access.hasMemory(off));
    assert.isFalse(yield* access.hasMemory(scratch));
    assert.isTrue(yield* access.hasMemory(navigationOnly));
    assert.include(
      yield* access.firstTurnBrief(navigationOnly, "Reach profile"),
      "Project Navigation Memory is enabled",
    );
    assert.strictEqual(yield* access.firstTurnBrief(off, "Test the dashboard"), "");
  }).pipe(Effect.provide(layer)),
);
