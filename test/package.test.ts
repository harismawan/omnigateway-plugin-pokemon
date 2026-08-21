/**
 * The shape of the thing that actually gets published.
 *
 * This exists because the first build of this package was unusable and every
 * other test passed. `npm pack` from the repository root produced a tarball with
 * the manifest at `package/dist/pokemon/omni-plugin.json`; `omni plugin install`
 * strips one wrapping directory and then requires `omni-plugin.json` at the root
 * of what remains, so every install was refused with "has no omni-plugin.json at
 * its root" — including the one command this project's own README leads with.
 *
 * Nothing in a unit test could have caught that. The bug lived entirely in the
 * layout of a directory no test looked at, and the only way to see it was to
 * build the package and hand it to the installer. So this test builds it.
 *
 * It is slower than the rest of the suite on purpose. The alternative is
 * asserting against a description of the layout, which is the same class of
 * mistake: a fixture copied from the code under test agrees with it by
 * construction and tells you nothing about the world.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "pokemon");

// One build for the whole file. `bun run build` is the same command CI and the
// release workflow run — not a reimplementation of it.
const built = Bun.spawnSync(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });

type Manifest = { id: string; version: string; server?: string; ui?: string };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("the published package", () => {
  test("builds", () => {
    expect(built.exitCode).toBe(0);
  });

  test("puts the manifest at its own root, where the installer looks", () => {
    // The whole point. After `npm pack` wraps this directory in `package/` and
    // the host strips that one level, this is the file it must find first.
    expect(existsSync(join(out, "omni-plugin.json"))).toBe(true);
  });

  test("has no nested directory standing between the root and the manifest", () => {
    // The failure mode, stated as itself: a `dist/` or a `pokemon/` inside the
    // package means the manifest is one level too deep and the install is
    // refused. Asserting the absence of the specific wrapper that broke it.
    expect(existsSync(join(out, "dist"))).toBe(false);
    expect(existsSync(join(out, "pokemon"))).toBe(false);
  });

  test("ships the entry points its own manifest names", () => {
    // Read from the manifest rather than hardcoded, so a manifest that renames
    // `server` without the build following cannot pass. The paths are relative
    // to the plugin root, which is this directory.
    const manifest = readJson<Manifest>(join(out, "omni-plugin.json"));
    for (const entry of [manifest.server, manifest.ui]) {
      expect(entry).toBeDefined();
      expect(existsSync(join(out, entry as string))).toBe(true);
    }
  });

  test("declares no dependencies, because nothing installs them", () => {
    // `omni plugin install` unpacks a tarball and imports what is inside it. It
    // never runs `npm install`, so a dependency here would describe a step that
    // does not happen — and the server bundle would fail to import at boot with
    // a missing module the operator has no way to supply.
    const pkg = readJson<Record<string, unknown>>(join(out, "package.json"));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  test("agrees with the manifest about which version this is", () => {
    const pkg = readJson<{ version: string }>(join(out, "package.json"));
    const manifest = readJson<Manifest>(join(out, "omni-plugin.json"));
    expect(pkg.version).toBe(manifest.version);
  });

  test("carries no zod, so the subpath split is still doing its job", () => {
    // `@omnigateway/plugin-api`'s root entry pulls the manifest schema and with
    // it zod. Every import here goes through `/define` or `/events`, or is a
    // type-only import of the root that erases. One value import of the root
    // would take this bundle from 36 KB to over half a megabyte, and nothing
    // else in this suite would notice.
    const server = readFileSync(join(out, "server", "index.js"), "utf8");
    expect(server).not.toContain("zod");
  });

  /**
   * The packages the console owns, which this bundle must import rather than
   * carry.
   *
   * Nothing asserted this until the panel started reading the console's LIVE
   * switch, and the omission was survivable while every entry was React: two
   * React copies throw "invalid hook call" the moment a panel renders, so the
   * mistake announced itself.
   *
   * `@omnigateway/dashboard-sdk` does not announce it. The SDK holds
   * `LiveContext`, so a bundled copy is a second context object — this panel
   * would find no provider above it, take the "polling is off" default, and
   * never refresh again. Nothing throws, nothing is logged, and the panel looks
   * exactly like one the operator paused on purpose. It is also the entry
   * likeliest to be dropped from `build:ui`, because it is the one package here
   * that is obviously ours.
   */
  const HOST_OWNED = [
    "react",
    "react/jsx-runtime",
    "styled-components",
    "@tanstack/react-query",
    "@omnigateway/dashboard-sdk",
  ];

  test("imports the console's packages rather than bundling them", () => {
    const ui = readFileSync(join(out, "ui", "index.js"), "utf8");

    // The bundle's own import graph, read by the transpiler that produced it.
    //
    // A regex was tried and it was worse than useless. Bun's minifier
    // concatenates modules, so most imports end up preceded by `}` rather than
    // by a newline — on the real bundle a hand-written pattern matched 8 of 17
    // occurrences, and the SDK assertion below passed only because that import
    // happens to sit at byte 0. Reordering the modules would have turned the
    // test red on a correct build.
    const imported = new Set(
      new Bun.Transpiler({ loader: "js" }).scanImports(ui).map((found) => found.path),
    );

    // Each named on its own line rather than looped, because the loop this
    // replaces read as a six-entry guard and was `if (P) assert(P)` — a
    // tautology that could not fail for any input. Four of the five entries
    // were unguarded, and dropping `styled-components` from `build:ui` inflated
    // the bundle from 20.7 KB to 47.8 KB with a duplicate `ThemeContext` while
    // the whole suite stayed green: the same silent duplicate-context failure
    // this file exists to catch, one package over.
    for (const name of HOST_OWNED) {
      expect(imported).toContain(name);
    }

    // Measured: dropping any of `react`, `styled-components`,
    // `@tanstack/react-query` or `@omnigateway/dashboard-sdk` from `build:ui`
    // now fails here. Dropping `react/jsx-runtime` does not, and that is not a
    // gap — Bun emits that specifier as an import either way under the
    // automatic JSX runtime, so the flag is belt-and-braces and there is no
    // different bundle to catch.

    // `react-dom` is deliberately not in that list. The panel renders inside
    // the console's tree and never mounts a root, so it does not import it —
    // asserting its presence would fail on a correct build, and asserting its
    // absence would pass whether or not it was external.
    expect(imported).not.toContain("react-dom");
  });

  test("carries no second copy of the context the console owns", () => {
    // An import can coexist with a copy: a bundler that inlined the SDK and
    // still imported React satisfies every assertion above. This is the one
    // that says the SDK's own module scope is not in here.
    //
    // `createContext` and not a message string. The first version of this
    // looked for `"must not be empty"` from the SDK's `pluginApiPath`, which
    // was worthless — the panel never imports `createPluginApi`, so `api.ts` is
    // tree-shaken out and the string is absent from the bundled build too. It
    // asserted a thing that was already true, under a comment calling itself
    // proof. Measured on the two builds: `createContext` is 0 here and 1 when
    // the SDK is inlined, which is the whole difference.
    const ui = readFileSync(join(out, "ui", "index.js"), "utf8");
    expect(ui).not.toContain("createContext");
  });
});
