import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const file = path.join(import.meta.dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  try {
    const html = await fs.readFile(file, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error.message);
  }
});

server.listen(4174, '127.0.0.1', () => {
  console.log('PREVIEW http://127.0.0.1:4174');
});
