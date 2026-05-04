const net = require('net');
const client = new net.Socket();
client.connect(49123, '127.0.0.1');

let buf = '';
client.on('data', (data) => {
  buf += data.toString();
});

setTimeout(() => {
  console.log(buf.substring(buf.length - 50));
  console.log("Includes \\n? ", buf.includes('\n'));
  console.log("Includes \\0? ", buf.includes('\0'));
  console.log("Includes \\r? ", buf.includes('\r'));
  client.destroy();
}, 1000);
