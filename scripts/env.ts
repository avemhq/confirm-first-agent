import nextEnv from '@next/env'

/**
 * Loads the env files of `root` with the loader Next.js itself uses: same files, same order
 * (.env.<mode>.local, .env.local, .env.<mode>, .env; with NODE_ENV=test without .env.local), same
 * $VAR expansion. Variables already set in
 * the environment win. No chdir. Call it once per process: @next/env caches the result.
 */
export function loadEnvFrom(root: string, dev = process.env.NODE_ENV !== 'production'): void {
  nextEnv.loadEnvConfig(root, dev, { info: () => {}, error: console.error })
}
