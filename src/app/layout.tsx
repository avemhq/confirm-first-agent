import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Confirm-first agent',
  description: 'A chat agent for a B2B project app that can act, but never writes without a human click.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
