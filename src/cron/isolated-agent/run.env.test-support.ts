// Preserve the caller environment around isolated runner tests.
export function clearFastTestEnv(): string | undefined {
  const previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return previousFastTestEnv;
}

export function restoreFastTestEnv(previousFastTestEnv: string | undefined): void {
  if (previousFastTestEnv == null) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
}
