/** Tiny argv parser: --user bob --db path, plus positionals. */
export function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? ''
      i++
    } else positional.push(a)
  }
  return { flags, positional }
}
