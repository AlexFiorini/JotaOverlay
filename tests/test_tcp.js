const net = require('net');

const client = new net.Socket();
client.connect(49123, '127.0.0.1', () => {
  console.log('[+] Connected via raw TCP to 49123');
});

client.on('data', (data) => {
  console.log('[+] Data received:', data.toString().substring(0, 200));
  client.destroy();
});

client.on('error', (err) => {
  console.log('[-] TCP error:', err.message);
});
