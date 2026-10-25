import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = { title: 'Nexa', description: 'Messaging, social and services in one place.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            Nexa
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
