// Minimal SMTP receiver for end-to-end tests: accepts any message and keeps it in memory.
// Local development uses Mailpit (infra/docker-compose.yml) instead.
import net from 'node:net';

export function startSmtpSink(port) {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let data = '';
    const reply = (l) => sock.write(l + '\r\n');
    reply('220 sink ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(decode(data));
            data = '';
            reply('250 OK');
          } else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') reply('250 sink');
        else if (cmd === 'DATA') { inData = true; reply('354 go'); }
        else if (cmd === 'QUIT') { reply('221 bye'); sock.end(); }
        else reply('250 OK');
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ messages, close: () => server.close() })));
}

function decode(raw) {
  // Undo quoted-printable soft breaks and escapes so links are intact.
  const body = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const to = (raw.match(/^To: (.+)$/m) || [])[1] || '';
  const subject = (raw.match(/^Subject: (.+)$/m) || [])[1] || '';
  return { to: to.replace(/[<>]/g, '').trim(), subject, body };
}
