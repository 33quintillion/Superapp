import Link from 'next/link';
import { authed } from '@/lib/session';
import { resetContactCode } from '../actions';
import { QrImage } from '../qr-image';

/** "My QR code": others scan it in SuperApp, or type the code, to start a chat with you. */
export async function MyQrCode() {
  const mine = await authed<{ code: string; qr: string }>('GET', '/v1/me/contact-code').catch(() => null);
  if (!mine) return null;
  const shown = `${mine.code.slice(0, 5)}-${mine.code.slice(5)}`;
  return (
    <div className="card my-qr" data-testid="my-qr">
      <QrImage text={mine.qr} label="Your SuperApp QR code" className="my-qr-code" />
      <div className="stack">
        <p>Let people scan this in SuperApp to start a chat with you. Your phone number stays private.</p>
        <p>
          Or they can type your code: <strong data-testid="my-code" className="typed-code">{shown}</strong>
        </p>
        <form action={resetContactCode}>
          <button className="btn quiet small" type="submit" data-testid="reset-code">
            Reset code
          </button>{' '}
          <small className="muted">Old screenshots and printouts stop working.</small>
        </form>
        <form action="/add" method="get" className="new-chat">
          <input name="code" placeholder="Someone’s code, like ABCDE-23456" aria-label="Someone else’s code" maxLength={20} required />
          <button className="btn small" type="submit">
            Find
          </button>
        </form>
        <Link href="/chats" className="small">
          Go to chats
        </Link>
      </div>
    </div>
  );
}
