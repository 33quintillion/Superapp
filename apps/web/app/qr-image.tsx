import { encodeQr } from '@/lib/qr';

/** A QR code as an SVG: dark navy modules on white with the standard quiet zone, so any phone reads it. */
export function QrImage({ text, label, className }: { text: string; label: string; className?: string }) {
  const modules = encodeQr(text);
  const n = modules.length + 8; // four modules of quiet zone on each side
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className={className} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#14213d" />
    </svg>
  );
}
