// Tạo bản demo một file (engine nhúng sẵn, không cần server): dist/ai-rua-bat-demo.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'public/engine.js'), 'utf8');

html = html
  .replace('<script src="config.js"></script><!--SERVER_CONFIG-->\n', '')
  .replace('<script src="engine.js"></script><!--ENGINE-->', () => `<script>\n${engine}\n</script>`);
if (html.includes('config.js') || html.includes('src="engine.js"')) throw new Error('Không tìm thấy marker SERVER_CONFIG / ENGINE trong index.html');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/ai-rua-bat-demo.html'), html);
console.log('Đã tạo dist/ai-rua-bat-demo.html');
