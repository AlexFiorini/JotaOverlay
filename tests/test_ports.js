const WebSocket = require('ws');

const ports = [49122, 49123, 49222, 49223, 49322];

ports.forEach(port => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  
  ws.on('open', () => {
    console.log(`[+] SUCCESS: Connected to port ${port}`);
    ws.close();
  });
  
  ws.on('error', (err) => {
    console.log(`[-] Failed port ${port}: ${err.message}`);
  });
});
