import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(root, 'public');
const mathDir = path.join(here, 'math-preview');
const materialDir = path.join(here, 'material-library');
const katexDir = path.join(root, 'node_modules', 'katex', 'dist');
const requested = process.env.PORT;
const port = requested === '0' ? 0 : Number(requested || 4175);

const app = express();

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).type('text/plain').send('Method Not Allowed');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/vendor/katex', express.static(katexDir));
app.use('/vendor', express.static(path.join(publicDir, 'vendor')));
app.use('/core', express.static(path.join(publicDir, 'core')));
app.use('/features', express.static(path.join(publicDir, 'features')));
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(publicDir, 'style.css'));
});
app.use('/math-preview', express.static(mathDir));
app.use('/material-library', express.static(materialDir));
app.get('/', (req, res) => {
  res.redirect(302, '/math-preview/');
});

const server = app.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`DEMO http://127.0.0.1:${actual}/math-preview/`);
  console.log(`DEMO http://127.0.0.1:${actual}/material-library/`);
});
