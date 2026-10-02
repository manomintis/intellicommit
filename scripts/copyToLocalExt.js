// Copies the compiled bundle into .local-ext/dist, the development folder with the in-box button.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/** Returns false when there is no build yet or no .local-ext folder. */
function copyToLocalExt() {
  const source = path.join(root, 'dist', 'extension.js');
  const target = path.join(root, '.local-ext', 'dist');
  if (!fs.existsSync(source) || !fs.existsSync(path.dirname(target))) {
    return false;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(source, path.join(target, 'extension.js'));
  const map = `${source}.map`;
  if (fs.existsSync(map)) {
    // The copy sits one folder deeper, so source paths need one more "../".
    const json = JSON.parse(fs.readFileSync(map, 'utf8'));
    json.sources = json.sources.map((s) => `../${s}`);
    fs.writeFileSync(path.join(target, 'extension.js.map'), JSON.stringify(json));
  }
  return true;
}

module.exports = { copyToLocalExt };
