export function gitSourceEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_SHALLOW_FILE",
  ]) {
    delete selected[key];
  }
  return selected;
}
