import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/cookies';
import './globals.css';

export const metadata: Metadata = { title: 'Nexa', description: 'Messaging, social and services in one place.' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const signedIn = !!(jar.get(ACCESS_COOKIE) || jar.get(REFRESH_COOKIE));
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="top">
          <Link href="/" className="brand">
            Nexa
          </Link>
          {signedIn && (
            <nav className="top-nav">
              <Link href="/feed">Feed</Link>
              <Link href="/chats">Chats</Link>
              <Link href="/communities">Communities</Link>
              <Link href="/business">Businesses</Link>
              <Link href="/orders">Orders</Link>
              <Link href="/apps">Apps</Link>
              <Link href="/account">Account</Link>
            </nav>
          )}
        </header>
        {/* The skip link's target. Screens put their own <main> inside. */}
        <div id="main" tabIndex={-1} className="main-target">
          {children}
        </div>
      </body>
    </html>
  );
}
