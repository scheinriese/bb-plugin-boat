// Scripts the plugin runs in a sandbox are POSIX shell (bash on every
// provider so far: SandboxCapabilities.shell).

/** One argument, quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
