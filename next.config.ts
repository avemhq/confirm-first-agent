import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Do not write AGENTS.md / CLAUDE.md into the repo on `next dev`.
  agentRules: false,
}

export default nextConfig
