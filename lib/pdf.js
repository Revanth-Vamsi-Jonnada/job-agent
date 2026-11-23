// HTML -> PDF using an installed Chromium browser (Edge or Chrome) in headless mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

let browserPath;
function findBrowser() {
  if (browserPath !== undefined) return browserPath;
  browserPath = CANDIDATES.find(p => p && fs.existsSync(p)) || null;
  return browserPath;
}

const profileDir = path.join(os.tmpdir(), 'job-agent-pdf-profile');
let chain = Promise.resolve();

function htmlToPdf(htmlFile, pdfFile) {
  const browser = findBrowser();
  if (!browser) return Promise.resolve(null);
  // The browser works on copies in a short temp folder: Windows browsers cannot open
  // files whose full path is longer than 260 characters, and app folders can be deep.
  const run = () => new Promise(resolve => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-'));
    const tmpHtml = path.join(work, 'doc.html');
    const tmpPdf = path.join(work, 'doc.pdf');
    const done = result => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} resolve(result); };
    try { fs.copyFileSync(htmlFile, tmpHtml); fs.rmSync(pdfFile, { force: true }); } catch (e) { console.warn('[pdf]', e.message); return done(null); }
    execFile(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
      // Inside a Linux container (Render) Chromium runs as root with a tiny /dev/shm.
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--user-data-dir=${profileDir}`, `--print-to-pdf=${tmpPdf}`, pathToFileURL(tmpHtml).href,
    ], { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (fs.existsSync(tmpPdf)) {
        try { fs.copyFileSync(tmpPdf, pdfFile); return done(pdfFile); } catch (e) { console.warn('[pdf]', e.message); return done(null); }
      }
      console.warn('[pdf] failed:', err ? err.message : 'no file', String(stderr || '').slice(-400));
      done(null);
    });
  });
  // One browser at a time: running many headless instances in parallel is slow and flaky.
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

module.exports = { findBrowser, htmlToPdf };
