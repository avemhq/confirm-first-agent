import nextEnv from '@next/env'

/**
 * Loads the env files of `root` with the loader Next.js itself uses: same files, same order
 * (.env.<mode>.local, .env.local, .env.<mode>, .env), same $VAR expansion. Variables already set in
 * the environment win. No side effects beyond process.env (no chdir), so tests can call it.
 */
export function loadEnvFrom(root: string, dev = process.env.NODE_ENV !== 'production'): void {
  nextEnv.loadEnvConfig(root, dev, { info: () => {}, error: console.error }, true)
}
