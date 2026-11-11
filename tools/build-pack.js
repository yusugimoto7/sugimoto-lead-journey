// Builds the static dashboard into dist/: the page, the chart library, the browser bundle and data.bin, the
// anonymised data (lib/pack.js) gzipped and encrypted with PACK_PASSWORD (AES-256-GCM, key from PBKDF2-SHA256).
// The page asks for the password and decrypts in the browser, so the files can sit on a public static host.
// Run by .github/workflows/static.yml every hour; needs ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY,
// PACK_PASSWORD and PACK_KEY (the HMAC key for the contact hashes; never shipped).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ITERATIONS = 310000; // OWASP's PBKDF2-SHA256 figure; the browser repeats it once per unlock

async function main() {
  const { PACK_PASSWORD, PACK_KEY } = process.env;
  if (!PACK_PASSWORD || PACK_PASSWORD.length < 12) throw new Error('PACK_PASSWORD must be set, 12 characters or more');
  if (!PACK_KEY || PACK_KEY.length < 16) throw new Error('PACK_KEY must be set, 16 characters or more');
  const D = require('../lib/data');
  const A = require('../lib/analytics');
  const { encode } = require('../lib/pack');
  const { baseUrl } = require('../lib/odoo');

  await D.startLoad(true, true);
  if (!D.state.data) throw new Error(`no data: ${D.state.error}`);
  const hmac = (t) => crypto.createHmac('sha256', PACK_KEY).update(t).digest('base64url').slice(0, 12);
  const pack = encode(D.state.data, { hmac, emailKey: A.emailKey, phoneKey: A.phoneKey, metaPhone: A.metaPhone, odooUrl: baseUrl() });
  const gz = zlib.gzipSync(JSON.stringify(pack), { level: 9 });

  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(PACK_PASSWORD, salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gz), cipher.final(), cipher.getAuthTag()]); // WebCrypto wants the tag last
  const head = Buffer.from(JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64') }));
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data.bin'), Buffer.concat([len, head, body]));
  fs.copyFileSync(path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), path.join(OUT, 'vendor', 'chart.umd.js'));
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'browser.js')], bundle: true, minify: true, platform: 'browser', format: 'iife',
    outfile: path.join(OUT, 'app.js'), define: { 'process.env': '{}' },
    alias: { fs: path.join(__dirname, 'shims/fs.js'), os: path.join(__dirname, 'shims/os.js'), path: path.join(__dirname, 'shims/path.js') },
    logLevel: 'warning',
  });
  // Same page as the server's; the flag switches it to the local answers and the unlock screen.
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
    .replace('<script src="vendor/chart.umd.js"></script>', '<script src="vendor/chart.umd.js"></script>\n<script>window.LJ_STATIC={data:"data.bin"}</script>\n<script src="app.js"></script>');
  fs.writeFileSync(path.join(OUT, 'index.html'), page);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
  console.log(`[static] ${pack.leads.n} leads → data.bin ${kb('data.bin')} KB, app.js ${kb('app.js')} KB`);
}

main().then(() => process.exit(0), (e) => { console.error('[static] failed:', e.message); process.exit(1); });
