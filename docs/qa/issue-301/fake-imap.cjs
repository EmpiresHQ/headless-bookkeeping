// Empty SYNTHETIC TLS IMAP endpoint on loopback only; no messages or real mailbox.
const tls = require('node:tls'),
  fs = require('node:fs');
const log = [];
const save = () =>
  fs.writeFileSync(
    '.qa-data/fake-imap-events-live.json',
    JSON.stringify(
      { synthetic: true, emptyMailbox: true, events: log },
      null,
      2,
    ) + '\n',
  );
tls
  .createServer(
    {
      key: fs.readFileSync('.qa-tools/imap-key.pem'),
      cert: fs.readFileSync('.qa-tools/imap-cert.pem'),
    },
    (socket) => {
      socket.write('* OK SYNTHETIC301 empty IMAP ready\r\n');
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', (data) => {
        buffer += data.toString();
        let i;
        while ((i = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const parts = line.split(/\s+/),
            tag = parts[0],
            cmd = (parts[1] || '').toUpperCase();
          log.push({ command: cmd, at: new Date().toISOString() });
          save();
          const ok = (s = 'completed') => socket.write(`${tag} OK ${s}\r\n`);
          if (cmd === 'CAPABILITY') {
            socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
            ok();
          } else if (cmd === 'LOGIN' || cmd === 'AUTHENTICATE')
            ok('authenticated synthetic account');
          else if (cmd === 'LIST' || cmd === 'LSUB') {
            socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
            ok();
          } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
            socket.write(
              '* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 301] synthetic\r\n* OK [UIDNEXT 1] synthetic\r\n',
            );
            ok('[READ-ONLY] INBOX');
          } else if (cmd === 'STATUS') {
            socket.write(
              '* STATUS INBOX (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 301 UNSEEN 0)\r\n',
            );
            ok();
          } else if (
            cmd === 'UID' ||
            cmd === 'FETCH' ||
            cmd === 'SEARCH' ||
            cmd === 'NOOP' ||
            cmd === 'CLOSE'
          )
            ok();
          else if (cmd === 'LOGOUT') {
            socket.write('* BYE synthetic endpoint closing\r\n');
            ok();
            socket.end();
          } else socket.write(`${tag} BAD unsupported synthetic command\r\n`);
        }
      });
    },
  )
  .listen(14301, '127.0.0.1', () => {
    save();
    console.log('synthetic empty TLS IMAP14301');
  });
