import { marked } from '../vendor/marked.esm.js';
import { mathBlockExtension } from './math-extension.js';

marked.use({ extensions: [mathBlockExtension] });

export { marked };
