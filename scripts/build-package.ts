/**
 * Assembles the directory that is actually published.
 *
 * The published tarball is **not** this repository with a `files` allowlist, and
 * the difference is not cosmetic. `omni plugin install <name>` fetches a tarball,
 * strips exactly one wrapping directory — `package/`, for anything `npm pack`
 * produced — and then looks for `omni-plugin.json` at the root of what is left.
 *
 * Publishing from the repository root puts the manifest at
 * `package/dist/pokemon/omni-plugin.json`, which after stripping is
 * `dist/pokemon/omni-plugin.json`, which is not the root. The install is refused
 * with "has no omni-plugin.json at its root". That is not a hypothetical: this
 * package was built that way first and the headline install command in its own
 * README did not work.
 *
 * So the plugin's own layout has to *be* the package layout, and the way to get
 * that is to publish from the built directory. `scripts/build-npm.ts` in the
 * gateway repository does the same thing for the same reason.
 *
 * The generated manifest deliberately declares **no dependencies**. Nothing runs
 * `npm install` on a plugin: the host unpacks the tarball and imports what is
 * inside it. The server bundle is self-contained, and the UI's React and friends
 * come from the console's import map rather than from node_modules — declaring
 * them here would describe an installation step that never happens.
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const out = join(root, "dist", "pokemon");

type SourceManifest = {
  name: string;
  version: string;
  description: string;
  license: string;
  author: string;
  homepage: string;
  repository: unknown;
  bugs: unknown;
  keywords: string[];
};

const source = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as SourceManifest;

const manifest = JSON.parse(await readFile(join(root, "omni-plugin.json"), "utf8")) as {
  id: string;
  version: string;
};

// The two versions are one fact written twice, and a mismatch is invisible until
// an operator compares `omni plugin list` against npm and finds two answers.
if (manifest.version !== source.version) {
  throw new Error(
    `omni-plugin.json is ${manifest.version} but package.json is ${source.version}; ` +
      "they name the same release and must agree",
  );
}

await mkdir(out, { recursive: true });

await writeFile(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: source.name,
      version: source.version,
      description: source.description,
      license: source.license,
      author: source.author,
      homepage: source.homepage,
      repository: source.repository,
      bugs: source.bugs,
      keywords: source.keywords,
      // Everything the host reads, and nothing else. `files` is exhaustive here
      // because the directory is generated: anything not listed was not built.
      files: ["omni-plugin.json", "server", "ui", "README.md", "LICENSE"],
      publishConfig: { access: "public" },
    },
    null,
    2,
  )}\n`,
);

for (const file of ["omni-plugin.json", "README.md", "LICENSE"]) {
  await cp(join(root, file), join(out, file));
}

console.log(`assembled ${source.name}@${source.version} in dist/pokemon`);
