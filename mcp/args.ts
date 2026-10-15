/**
 * Tiny strict argv parser: `--user bob --db path` plus positionals.
 * Unknown flags and flags without a value are errors, so a typo like `--dbpath` cannot silently
 * fall back to the default database.
 */
export class ArgsError extends Error {}

export function parseArgs(
  argv: string[],
  allowed: readonly string[],
): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (!allowed.includes(name)) throw new ArgsError(`unknown flag --${name} (allowed: ${allowed.map((f) => `--${f}`).join(', ')})`)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new ArgsError(`flag --${name} needs a value`)
      if (value.trim() === '') throw new ArgsError(`flag --${name} must not be empty`)
      if (name in flags) throw new ArgsError(`flag --${name} given twice`)
      flags[name] = value
      i++
    } else positional.push(a)
  }
  return { flags, positional }
}

/** parseArgs for a CLI entry point: prints the error and the usage line, then exits 2. */
export function parseArgsOrExit(argv: string[], allowed: readonly string[], usage: string) {
  try {
    return parseArgs(argv, allowed)
  } catch (e) {
    if (!(e instanceof ArgsError)) throw e
    console.error(`${e.message}\nusage: ${usage}`)
    process.exit(2)
  }
}

/** For entry points that take no arguments: anything on the command line is an error, exit 2. */
export function noArgsOrExit(argv: string[], usage: string): void {
  if (argv.length) {
    console.error(`unexpected argument ${argv[0]}\nusage: ${usage}`)
    process.exit(2)
  }
}
