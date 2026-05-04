const net = require('net');
const client = new net.Socket();
client.connect(49123, '127.0.0.1');

client.on('data', (data) => {
  console.log('Hex dump:', data.toString('hex').substring(0, 100));
  console.log('End hex:', data.toString('hex').slice(-100));
  client.destroy();
});
