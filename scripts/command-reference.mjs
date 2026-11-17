import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const result = spawnSync(
  process.execPath,
  [entry, "capabilities", "--format", "json", "--no-config"],
  {
    encoding: "utf8",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("XHS_DL_"),
        ),
      ),
      XHS_DL_PROFILE: "default",
      XHS_DL_FORMAT: "json",
    },
  },
);
if (result.status !== 0)
  throw new Error("Build the CLI before generating command reference.");
const data = JSON.parse(result.stdout).data;
const markdown =
  "# Command reference\n\nGenerated from the CLI registry. Regenerate with `pnpm docs:generate`; edit command definitions in src/cli.ts.\n\n" +
  data.commands
    .map(
      (command) =>
        "## " +
        command.name +
        "\n\n" +
        command.description +
        "\n\n" +
        command.options
          .map(
            (option) =>
              "- `" +
              option.flags +
              "`: " +
              option.description +
              (option.default === null
                ? ""
                : " (default: " + option.default + ")"),
          )
          .join("\n"),
    )
    .join("\n\n") +
  "\n";
const target = new URL(
  "../skills/xhs-dl/references/commands.md",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== markdown)
    throw new Error("Command reference is stale: run pnpm docs:generate.");
} else await writeFile(target, markdown);
