// Canonical lint command ownership shared by local and hosted check plans.
export type ChangedCheckCommand = {
  coreTestCheck?: "checkBoundary" | "checkTypes";
  name: string;
  args: string[];
  bin?: string;
  env?: NodeJS.ProcessEnv;
};

export type CiLintSelection = {
  files: string[];
  fullScope?: boolean;
  rootTestFiles?: string[];
  coreStripes: number[];
  extensionStripes: number[];
  groups: ("core" | "extensions" | "scripts")[];
  central: boolean;
};

export const CORE_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.core.json";
export const EXTENSIONS_OXLINT_TS_CONFIG = "extensions/tsconfig.json";
export const SCRIPTS_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.scripts.json";

export function targetedLintOwner(
  command: ChangedCheckCommand,
): "core" | "extensions" | "scripts" | undefined {
  if (
    command.bin !== "node" ||
    command.args[0] !== "scripts/run-oxlint.mjs" ||
    command.args[1] !== "--tsconfig"
  ) {
    return undefined;
  }
  return command.args[2] === CORE_OXLINT_TS_CONFIG
    ? "core"
    : command.args[2] === EXTENSIONS_OXLINT_TS_CONFIG
      ? "extensions"
      : command.args[2] === SCRIPTS_OXLINT_TS_CONFIG
        ? "scripts"
        : undefined;
}

export function fullLintOwners(command: ChangedCheckCommand): CiLintSelection["groups"] {
  const targeted = targetedLintOwner(command);
  if (targeted) {
    return [targeted];
  }
  if (command.bin) {
    return [];
  }
  switch (command.args[0]) {
    case "lint":
      return ["core", "extensions", "scripts"];
    case "lint:core":
      return ["core"];
    case "lint:extensions":
      return ["extensions"];
    case "lint:scripts":
      return ["scripts"];
    default:
      return [];
  }
}

export function centralFullLintCommands(
  command: ChangedCheckCommand,
  env: NodeJS.ProcessEnv,
): ChangedCheckCommand[] {
  if (!command.bin && command.args[0] === "lint") {
    // run-lint owns catalog verification and styles in addition to the Oxlint groups.
    return [
      { name: "Control UI i18n catalog", args: ["lint:ui:i18n"], env },
      {
        name: "lint UI styles",
        bin: "node",
        args: [
          "--import",
          "./scripts/tsx.mjs",
          "scripts/run-stylelint.mts",
          "ui/src/**/*.css",
          "ui/src/**/*.ts",
          "ui/public/themes/*.css",
        ],
        env,
      },
    ];
  }
  if (!command.bin && command.args[0] === "lint:scripts") {
    return [
      { name: "lint docker-e2e", args: ["lint:docker-e2e"], env },
      { name: "raw HTTP/2 import guard", args: ["lint:tmp:no-raw-http2-imports"], env },
    ];
  }
  return fullLintOwners(command).length ? [] : [command];
}

export function createCiLintCommands(
  selection: CiLintSelection,
  threads: 1 | 8,
  env: NodeJS.ProcessEnv,
): ChangedCheckCommand[] {
  if (selection.files.length === 0 && !selection.fullScope) {
    return [];
  }
  const command = (name: string, args: string[]) => ({
    name,
    bin: "node",
    env,
    args: [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/run-oxlint-shards.mts",
      ...args,
      `--threads=${threads}`,
      ...(!selection.fullScope ? ["--files-json", JSON.stringify(selection.files)] : []),
    ],
  });
  return [
    ...selection.coreStripes.map((stripe) =>
      command(`lint core file stripe ${stripe}`, [
        "--only=core",
        "--split-core",
        `--core-stripe=${stripe}/5`,
      ]),
    ),
    ...selection.extensionStripes.map((stripe) =>
      command(`lint extension file stripe ${stripe}`, [
        "--only=extensions",
        `--extension-stripe=${stripe}/6`,
      ]),
    ),
    ...(selection.groups.length
      ? [
          command(
            "lint remaining file groups",
            selection.groups.map((group) => `--only=${group}`),
          ),
        ]
      : []),
  ];
}
