const net = require('net');
const fs = require('fs');
const client = new net.Socket();

let buffer = '';

client.connect(49123, '127.0.0.1', () => {
  console.log('[RL] Connected');
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
      fs.appendFileSync('rl_events_dump.txt', JSON.stringify(msg) + '\n');
      console.log('Received:', msg.Event || msg.event);
      if (msg.Event === 'GoalScored' || msg.Event === 'UpdateState') {
         // just keep capturing
      }
    } catch (e) {}
  });
});

setTimeout(() => {
  client.destroy();
  console.log('Done capturing.');
}, 5000);
