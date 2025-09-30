// Minimal Node HTTP server for signing and verifying images via c2patool in Docker
// No external dependencies; uses JSON payloads with base64 image data.

const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DOCKER_IMAGE = process.env.C2PA_DOCKER_IMAGE || 'c2pa-demo';
const TRUST_BUNDLE = process.env.TRUST_BUNDLE_PATH || 'C2PA-TRUST-BUNDLE.pem';
const MANIFEST = process.env.MANIFEST_PATH || 'manifest.json';
const WORKDIR = process.cwd();
const UPLOAD_DIR = path.join(WORKDIR, 'uploads');
const MODE = (process.env.C2PA_MODE || '').toLowerCase();

function ensureUploadsDir() {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch {}
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'OPTIONS,GET,POST',
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function ensureDockerImage() {
  const inspect = spawnSync('docker', ['image', 'inspect', DOCKER_IMAGE], { encoding: 'utf8' });
  if (inspect.status === 0) return;
  console.log(`Building ${DOCKER_IMAGE} Docker image...`);
  const build = spawnSync('docker', ['build', '-t', DOCKER_IMAGE, '.'], { stdio: 'inherit' });
  if (build.status !== 0) {
    throw new Error('Failed to build Docker image');
  }
}

function randName(prefix, ext) {
  const id = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${id}${ext ? '.' + ext.replace(/^\./, '') : ''}`;
}

function dataUrlToBuffer(dataUrl) {
  // Accept either data URL or raw base64 string
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  const b64 = m ? m[2] : dataUrl;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

function runC2paSign(inputPath, outputPath) {
  // Mirrors c2pa_sign_tamper_verify.sh signing invocation
  const inRel = path.relative(WORKDIR, inputPath);
  const outRel = path.relative(WORKDIR, outputPath);
  const cmd = [
    'run', '--rm', '-v', `${WORKDIR}:/app`, '-w', '/app', DOCKER_IMAGE,
    'sh', '-c',
    `c2patool "${inRel}" -m "${MANIFEST}" -o "${outRel}" -f trust --trust_anchors "${TRUST_BUNDLE}"`
  ];
  const child = spawnSync('docker', cmd, { encoding: 'utf8' });
  return child;
}

function runC2paVerify(inputPath) {
  const inRel = path.relative(WORKDIR, inputPath);
  const cmd = [
    'run', '--rm', '-v', `${WORKDIR}:/app`, '-w', '/app', DOCKER_IMAGE,
    'sh', '-c', `c2patool "${inRel}" trust --trust_anchors "${TRUST_BUNDLE}"`
  ];
  const child = spawnSync('docker', cmd, { encoding: 'utf8' });
  return child;
}

function serveStatic(req, res) {
  const distDir = path.join(WORKDIR, 'client', 'dist');
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(distDir, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || !path.extname(filePath)) {
    filePath = path.join(distDir, 'index.html');
  }
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function hasLocalC2pa() {
  const probe = spawnSync('c2patool', ['--help'], { encoding: 'utf8' });
  return probe.status === 0;
}

function execSign(inputPath, outputPath) {
  if (MODE === 'local' || hasLocalC2pa()) {
    return spawnSync('c2patool', [
      inputPath,
      '-m', MANIFEST,
      '-o', outputPath,
      '-f', 'trust', '--trust_anchors', TRUST_BUNDLE
    ], { encoding: 'utf8' });
  }
  return runC2paSign(inputPath, outputPath);
}

function execVerify(inputPath) {
  if (MODE === 'local' || hasLocalC2pa()) {
    return spawnSync('c2patool', [
      inputPath,
      'trust', '--trust_anchors', TRUST_BUNDLE
    ], { encoding: 'utf8' });
  }
  return runC2paVerify(inputPath);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'OPTIONS,GET,POST',
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/api/health' || req.url === '/health')) {
    // Health check endpoint
    return json(res, 200, { ok: true, message: 'c2pa demo server' });
  }

  if (req.method === 'POST' && req.url === '/api/sign') {
    try {
      ensureUploadsDir();
      if (!(MODE === 'local' || hasLocalC2pa())) ensureDockerImage();
      const body = await parseBody(req);
      const { imageName, imageData } = body || {};
      const buf = dataUrlToBuffer(imageData);
      if (!buf) return json(res, 400, { ok: false, error: 'Invalid image data' });
      const ext = (imageName && path.extname(imageName)) || 'jpg';
      const inputName = randName('in', typeof ext === 'string' ? ext.replace(/^\./, '') : 'jpg');
      const outputName = randName('signed', typeof ext === 'string' ? ext.replace(/^\./, '') : 'jpg');
      const inPath = path.join(UPLOAD_DIR, inputName);
      const outPath = path.join(WORKDIR, outputName); // output in root so Docker can write
      fs.writeFileSync(inPath, buf);
      const result = execSign(inPath, outPath);
      if (result.status !== 0) {
        return json(res, 500, { ok: false, error: result.stderr || result.stdout || 'Signing failed' });
      }
      const signedBuf = fs.readFileSync(outPath);
      // Clean up input, keep output for debugging
      try { fs.unlinkSync(inPath); } catch {}
      const b64 = signedBuf.toString('base64');
      const mime = 'image/' + ((ext || '').toLowerCase().includes('png') ? 'png' : 'jpeg');
      return json(res, 200, { ok: true, fileName: outputName, dataUrl: `data:${mime};base64,${b64}` });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && req.url === '/api/verify') {
    try {
      ensureUploadsDir();
      if (!(MODE === 'local' || hasLocalC2pa())) ensureDockerImage();
      const body = await parseBody(req);
      const { imageName, imageData } = body || {};
      const buf = dataUrlToBuffer(imageData);
      if (!buf) return json(res, 400, { ok: false, error: 'Invalid image data' });
      const ext = (imageName && path.extname(imageName)) || 'jpg';
      const inputName = randName('verify', typeof ext === 'string' ? ext.replace(/^\./, '') : 'jpg');
      const inPath = path.join(UPLOAD_DIR, inputName);
      fs.writeFileSync(inPath, buf);
      const result = execVerify(inPath);
      // Clean up input file
      try { fs.unlinkSync(inPath); } catch {}
      const ok = result.status === 0;
      const output = (result.stdout || '').trim();
      const error = (result.stderr || '').trim();
      return json(res, 200, { ok, output, error });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // Try to serve static client build if present (including '/')
  if (req.method === 'GET') {
    const served = serveStatic(req, res);
    if (served) return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`c2pa demo server listening on http://localhost:${PORT}`);
});
