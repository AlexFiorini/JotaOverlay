const net = require('net');
const fs = require('fs');
const client = new net.Socket();

let buffer = '';
let lastEvent = '';

client.connect(49123, '127.0.0.1', () => {
  console.log('[RL] Connected. Waiting for events...');
});

client.on('data', (data) => {
  buffer += data.toString();
  const chunks = buffer.replace(/\}\s*\{/g, '}\n{').split('\n');
  buffer = chunks.pop();

  chunks.forEach(c => {
    c = c.trim();
    if (!c) return;
    try {
      const msg = JSON.parse(c);
      const ev = msg.Event || msg.event;
      if (ev !== 'UpdateState' && ev !== 'ClockUpdatedSeconds' && ev !== 'BallHit') {
         if (ev !== lastEvent) {
             console.log('EVENT OCCURRED:', ev);
             fs.appendFileSync('rl_events_log.txt', ev + '\n');
             lastEvent = ev;
         }
      }
    } catch (e) {}
  });
});
