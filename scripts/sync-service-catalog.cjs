// Keep the bundled web/mobile catalogs in step with the server's approved rates.
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../service-catalog.json');
const [webRoot, mobileRoot] = process.argv.slice(2);
if (!webRoot || !mobileRoot) {
  console.error('Usage: node scripts/sync-service-catalog.cjs "<web repo>" "<mobile MyApp repo>"');
  process.exit(1);
}
const content = '// Generated from OraVista-Server/service-catalog.json by scripts/sync-service-catalog.cjs.\nexport default ' + JSON.stringify(catalog, null, 2) + ';\n';
for (const root of [webRoot, mobileRoot]) {
  const src = path.resolve(root, 'src');
  if (!fs.statSync(src).isDirectory()) throw new Error('Expected an existing application src directory.');
  const file = path.join(src, 'data/serviceCatalog.js');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content) throw new Error(`Catalog differs: ${file}`);
  } else {
    fs.mkdirSync(path.join(src, 'data'), {recursive:true});
    fs.writeFileSync(file, content);
  }
}
