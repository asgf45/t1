const express  = require('express');
const cors     = require('cors');
const { exec, spawn } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');

// ── Web Push (optional — graceful fallback if not installed) ──────────────────
// Run: npm install web-push   to enable push notifications
let webpush = null;
try {
  webpush = require('web-push');
} catch {
  console.warn('[PUSH] web-push not installed. Run: npm install web-push');
  console.warn('[PUSH] Push notifications disabled — everything else works normally.');
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin:'*', methods:['GET','POST','DELETE','OPTIONS'], allowedHeaders:['Content-Type','X-Session-Id'] }));
app.use(express.json({ limit:'10mb' }));  // allow large cookie payloads
app.use(express.static(__dirname));

// ── Directories ───────────────────────────────────────────────────────────────
const TMP       = path.join(__dirname, 'tmp');
const DATA      = path.join(__dirname, 'data');          // persisted data
const COOKIES   = path.join(__dirname, 'data/cookies');  // per-session cookie files
const FETCHER   = path.join(__dirname, 'fetcher.py');
const JOBS_FILE  = path.join(DATA, 'jobs.json');
const HIST_FILE  = path.join(DATA, 'history.json');
const VAPID_FILE = path.join(DATA, 'vapid.json');
const SUBS_FILE  = path.join(DATA, 'subscriptions.json');

for (const d of [TMP, DATA, COOKIES]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── VAPID / Push setup ────────────────────────────────────────────────────────
let VAPID_KEYS = loadJSON(VAPID_FILE, null);
if (!VAPID_KEYS) {
  // Generate keys once and persist them
  try {
    if (webpush) {
      VAPID_KEYS = webpush.generateVAPIDKeys();
    } else {
      // Fallback: generate raw ECDH keys without web-push
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      VAPID_KEYS = {
        publicKey:  ecdh.getPublicKey('base64url'),
        privateKey: ecdh.getPrivateKey('base64url'),
      };
    }
    saveJSON(VAPID_FILE, VAPID_KEYS);
    console.log('[PUSH] Generated new VAPID keys → data/vapid.json');
  } catch(e) {
    console.warn('[PUSH] Could not generate VAPID keys:', e.message);
    VAPID_KEYS = { publicKey: null, privateKey: null };
  }
}

if (webpush && VAPID_KEYS.publicKey && VAPID_KEYS.privateKey) {
  try {
    webpush.setVapidDetails(
      'mailto:nexload@localhost',
      VAPID_KEYS.publicKey,
      VAPID_KEYS.privateKey
    );
    console.log('[PUSH] VAPID configured ✓');
  } catch(e) {
    console.warn('[PUSH] VAPID setup failed:', e.message);
  }
}

// sessionId → push subscription object
let pushSubs = loadJSON(SUBS_FILE, {});

const SERVER_START = Date.now();

// ── State (in-memory + persisted) ─────────────────────────────────────────────
const dlTokens = new Map();   // token → { filePath, filename, mime, size, expires }
let   jobs     = loadJSON(JOBS_FILE, {});   // jobId → job object
let   history  = loadJSON(HIST_FILE, []);   // array of completed entries
const queue    = [];          // pending { jobId, run } functions
let   running  = 0;
const MAX_PARALLEL = 2;       // max simultaneous downloads
const activeProcs = new Map(); // jobId → child_process, for cancel/kill

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  // Expired tokens
  for (const [tok, m] of dlTokens) {
    if (m.expires < now) { fs.unlink(m.filePath, ()=>{}); dlTokens.delete(tok); }
  }
  // Old tmp files (>30 min)
  fs.readdir(TMP, (err, files) => {
    if (err) return;
    files.forEach(f => {
      const fp = path.join(TMP, f);
      fs.stat(fp, (e,s) => { if (!e && now - s.mtimeMs > 30*60*1000) fs.unlink(fp,()=>{}); });
    });
  });
  // Trim history to last 200 entries
  if (history.length > 200) { history = history.slice(-200); saveJSON(HIST_FILE, history); }
  // Persist active jobs
  saveJSON(JOBS_FILE, jobs);
}, 5*60*1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(name) {
  return (name||'download').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').replace(/\s+/g,' ').trim().substring(0,120)||'download';
}
function makeId()    { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function execP(cmd, opts={}) {
  return new Promise((res,rej) => {
    exec(cmd, { maxBuffer:200*1024*1024, ...opts }, (err,stdout,stderr) => {
      if (err) rej({ err,stderr,stdout }); else res({ stdout,stderr });
    });
  });
}

function runFetcher(args, timeoutMs=120000, onStderr, onProc) {
  return new Promise((resolve, reject) => {
    const py   = process.platform==='win32' ? 'python' : 'python3';
    const proc = spawn(py, [FETCHER,...args], { env:{...process.env, PYTHONIOENCODING:'utf-8'} });
    let stdout='', stderr='', killed=false;

    if (onProc) onProc(proc);   // hand process to caller immediately so it can be killed

    const timer = setTimeout(() => {
      killed = true; proc.kill('SIGTERM');
      reject(`Timed out after ${Math.round(timeoutMs/1000)}s`);
    }, timeoutMs);

    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => { stderr += d; if (onStderr) onStderr(d.toString()); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) reject(parsed.error); else resolve(parsed);
      } catch { reject(stderr.trim() || `fetcher exited ${code}`); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e.message); });
  });
}

// Session cookie file path
function cookieFile(sessionId) {
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g,'').substring(0,64);
  if (!safe) return null;
  return path.join(COOKIES, `${safe}.txt`);
}

// ── Queue ─────────────────────────────────────────────────────────────────────
function enqueue(jobId, runFn) {
  queue.push({ jobId, run: runFn });
  drainQueue();
}

function drainQueue() {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const { jobId, run } = queue.shift();
    running++;
    patchJob(jobId, { status:'running', message:'Starting…' });
    run().finally(() => { running--; drainQueue(); });
  }
}

function patchJob(jobId, patch) {
  if (!jobs[jobId]) return;
  Object.assign(jobs[jobId], patch);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req,res) => {
  res.json({ status:'ok', server:'NexLoad', version:'5.0.0' });
});

// ── Status dashboard ──────────────────────────────────────────────────────────
app.get('/api/status', (req,res) => {
  const cpus = os.cpus();
  const totalMem  = os.totalmem();
  const freeMem   = os.freemem();

  // Tmp folder size
  let tmpSize = 0;
  try {
    fs.readdirSync(TMP).forEach(f => {
      try { tmpSize += fs.statSync(path.join(TMP,f)).size; } catch {}
    });
  } catch {}

  const activeJobs = Object.values(jobs).filter(j => j.status==='running'||j.status==='pending');
  const doneJobs   = Object.values(jobs).filter(j => j.status==='done');
  const errJobs    = Object.values(jobs).filter(j => j.status==='error');

  res.json({
    uptime_s:   Math.round((Date.now()-SERVER_START)/1000),
    uptime_h:   formatUptime(Date.now()-SERVER_START),
    cpu_count:  cpus.length,
    cpu_model:  cpus[0]?.model || 'unknown',
    mem_total_mb:  Math.round(totalMem/1024/1024),
    mem_free_mb:   Math.round(freeMem/1024/1024),
    mem_used_pct:  Math.round((totalMem-freeMem)/totalMem*100),
    tmp_size_mb:   +(tmpSize/1024/1024).toFixed(1),
    queue_length:  queue.length,
    parallel_running: running,
    max_parallel:  MAX_PARALLEL,
    jobs_active:   activeJobs.length,
    jobs_done:     doneJobs.length,
    jobs_error:    errJobs.length,
    history_count: history.length,
    tokens_alive:  dlTokens.size,
    platform:      process.platform,
    node_version:  process.version,
  });
});

function formatUptime(ms) {
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d>0) return `${d}d ${h%24}h`;
  if (h>0) return `${h}h ${m%60}m`;
  return `${m}m ${s%60}s`;
}

// ── Info ──────────────────────────────────────────────────────────────────────
app.post('/api/info', async (req,res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'URL required' });
  const sessionId = req.headers['x-session-id'];
  const cf = cookieFile(sessionId);
  const args = ['info', url, ...(cf && fs.existsSync(cf) ? [cf] : [])];
  try {
    const info = await runFetcher(args, 90000);
    res.json(info);
  } catch(e) {
    // bare fallback
    try {
      const { stdout } = await execP(`yt-dlp --dump-json --no-playlist "${url.replace(/"/g,'\\"')}"`);
      const raw = JSON.parse(stdout);
      const formats = (raw.formats||[]).filter(f=>f.ext!=='mhtml'&&f.ext!=='none').map(f=>{
        const has_v = f.vcodec&&f.vcodec!=='none';
        let has_a = f.acodec&&f.acodec!=='none';
        let fmt_id = f.format_id;
        if (has_v&&!has_a){ fmt_id=`${fmt_id}+bestaudio/${fmt_id}`; has_a=true; }
        return {
          format_id:fmt_id, ext:f.ext,
          resolution:f.resolution||(f.height?`${f.height}p`:'audio only'),
          filesize:f.filesize, filesize_h:f.filesize?`${(f.filesize/1024/1024).toFixed(1)} MB`:null,
          height:f.height, fps:f.fps, tbr:f.tbr, abr:f.abr,
          vcodec:f.vcodec, acodec:f.acodec, hasVideo:has_v, hasAudio:has_a,
          is_4k:(f.height||0)>=2160, is_hd:(f.height||0)>=1080,
          label:[f.height?`${f.height}p`:'',f.ext?.toUpperCase(),
            has_v&&has_a?'video+audio':has_v?'video only':'audio only',
            f.tbr?`${Math.round(f.tbr)}kbps`:''
          ].filter(Boolean).join(' · ')
        };
      });
      res.json({ title:raw.title, thumbnail:raw.thumbnail, duration:raw.duration,
        uploader:raw.uploader, view_count:raw.view_count, formats,
        has_4k:formats.some(f=>f.is_4k), format_count:formats.length });
    } catch(e2) {
      res.status(500).json({ error:'Failed to fetch info', detail:String(e2).substring(0,400) });
    }
  }
});

// ── Playlist ──────────────────────────────────────────────────────────────────
app.post('/api/playlist', async (req,res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'URL required' });
  const sessionId = req.headers['x-session-id'];
  const cf = cookieFile(sessionId);
  const args = ['playlist', url, ...(cf && fs.existsSync(cf) ? [cf] : [])];
  try {
    const data = await runFetcher(args, 120000);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error:'Playlist fetch failed', detail:String(e).substring(0,400) });
  }
});

// ── Cookies ───────────────────────────────────────────────────────────────────

// Upload / save cookies.txt for a session
app.post('/api/cookies', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error:'X-Session-Id header required' });
  const { content } = req.body;
  if (!content || typeof content !== 'string') return res.status(400).json({ error:'content required' });
  if (content.length > 2*1024*1024) return res.status(400).json({ error:'Cookies file too large (max 2MB)' });

  const cf = cookieFile(sessionId);
  if (!cf) return res.status(400).json({ error:'Invalid session id' });

  try {
    fs.writeFileSync(cf, content, 'utf8');
    res.json({ ok:true, message:'Cookies saved. They will be used for your downloads.' });
  } catch(e) {
    res.status(500).json({ error:'Failed to save cookies' });
  }
});

// Check if session has cookies saved
app.get('/api/cookies', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.json({ hasCookies:false });
  const cf = cookieFile(sessionId);
  const has = !!(cf && fs.existsSync(cf));
  let size = 0;
  if (has) { try { size = fs.statSync(cf).size; } catch {} }
  res.json({ hasCookies:has, size_kb: has ? Math.round(size/1024) : 0 });
});

// Delete session cookies
app.delete('/api/cookies', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error:'X-Session-Id required' });
  const cf = cookieFile(sessionId);
  if (cf && fs.existsSync(cf)) fs.unlinkSync(cf);
  res.json({ ok:true, message:'Cookies removed.' });
});

// ── Download ──────────────────────────────────────────────────────────────────
app.post('/api/download/format', async (req,res) => {
  const { url, format_id, type='mp4', title:clientTitle } = req.body;
  if (!url||!format_id) return res.status(400).json({ error:'url and format_id required' });

  const sessionId = req.headers['x-session-id'];
  const cf = cookieFile(sessionId);
  const hasCookies = !!(cf && fs.existsSync(cf));

  const jobId   = makeId();
  const id      = makeId();
  const outBase = path.join(TMP, id);

  jobs[jobId] = {
    status:'pending', progress:0, message:'Queued…',
    token:null, filename:null, error:null,
    created:Date.now(), url, format_id, type,
    title: clientTitle || 'download',
    sessionId: sessionId||null,
    outBase,   // ← persisted so server-restart recovery can re-use same path
  };
  saveJSON(JOBS_FILE, jobs);  // persist immediately so restart can see it

  res.json({ ok:true, jobId, position: queue.length+1 });

  enqueue(jobId, async () => {
    function up(patch) { patchJob(jobId, patch); }
    const cookiesArg = hasCookies ? [cf] : [];
    const safeTitle  = sanitize(clientTitle||'download');

    function onStderr(line) {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        const raw = parseFloat(m[1]);
        const pct = Math.min(90, Math.round(raw * 0.85 + 5));
        up({ progress: pct, message: `Downloading… ${raw.toFixed(1)}%` });

        // Send push at 25 / 50 / 75 % milestones (only once each)
        const job = jobs[jobId];
        if (job) {
          const prev = job._lastPushPct || 0;
          for (const milestone of [25, 50, 75]) {
            if (prev < milestone && raw >= milestone) {
              sendPush(sessionId, {
                type: 'progress', jobId, title: clientTitle || 'Download',
                pct: milestone, message: `${milestone}% downloaded`
              });
              up({ _lastPushPct: milestone });
              break;
            }
          }
        }
      }
      if (line.includes('[Merger]') || line.includes('Merging'))
        up({ progress: 92, message: 'Merging streams…' });
      if (line.includes('[ffmpeg]') || line.includes('Remux'))
        up({ progress: 95, message: 'Remuxing (zero quality loss)…' });
    }

    try {
      let result;
      if (type==='mp3') {
        up({ message:'Downloading audio…', progress:5 });
        result = await runFetcher(
          ['audio', url, outBase+'.mp3', ...cookiesArg], 1800000, onStderr,
          proc => activeProcs.set(jobId, proc)
        );
      } else {
        up({ message:'Downloading video…', progress:5 });
        result = await runFetcher(
          ['dl', url, format_id, outBase, ...cookiesArg], 3600000, onStderr,
          proc => activeProcs.set(jobId, proc)
        );
      }
      activeProcs.delete(jobId);

      const filePath = result.path;
      if (!fs.existsSync(filePath)) throw new Error('Output file not found');
      const size = fs.statSync(filePath).size;
      if (size < 1024) throw new Error(`File too small (${size}B)`);

      const ext      = path.extname(filePath).replace('.','') || (type==='mp3'?'mp3':'mp4');
      const mime     = ext==='mp3' ? 'audio/mpeg' : 'video/mp4';
      const filename = `${safeTitle}.${ext}`;
      const token    = makeToken();

      dlTokens.set(token, { filePath, filename, mime, size, expires:Date.now()+15*60*1000 });

      up({ status:'done', progress:100, message:`Ready: ${filename}`, token, filename, size, size_h:result.size_h });

      // Push notification — fires even if page is closed
      sendPush(sessionId, {
        type: 'done', jobId, title: safeTitle,
        filename, size_h: result.size_h,
        message: `${filename} is ready to save!`,
        token,
      });

      // Add to history
      history.push({
        id: jobId, title:safeTitle, filename, ext, size, size_h:result.size_h,
        url, ts: Date.now(), sessionId:sessionId||null,
      });
      saveJSON(HIST_FILE, history);
      saveJSON(JOBS_FILE, jobs);   // ← immediate persist on completion
      console.log(`[DONE] ${filename} — ${result.size_h}`);

    } catch(e) {
      activeProcs.delete(jobId);
      // If this job was cancelled, the error is expected — don't overwrite cancelled status
      if (jobs[jobId]?.status === 'cancelled') {
        saveJSON(JOBS_FILE, jobs);
        return;
      }
      console.error('[ERR]', jobId, e);
      up({ status:'error', progress:0, message:'Failed', error:String(e).substring(0,500) });
      sendPush(sessionId, {
        type: 'error', jobId, title: clientTitle || 'Download',
        message: 'Download failed — tap to retry',
      });
      saveJSON(JOBS_FILE, jobs);   // ← immediate persist on failure
    }
  });
});

// ── SSE job progress ──────────────────────────────────────────────────────────
app.get('/api/job/:jobId', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.flushHeaders();

  function send(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

  const job = jobs[req.params.jobId];
  if (!job) { send({ status:'error', error:'Job not found' }); return res.end(); }

  send({ ...job, queuePos: queue.findIndex(q=>q.jobId===req.params.jobId)+1 });
  if (job.status==='done'||job.status==='error'||job.status==='cancelled') return res.end();

  const iv = setInterval(() => {
    const j = jobs[req.params.jobId];
    if (!j) { clearInterval(iv); return res.end(); }
    send({ ...j, queuePos: queue.findIndex(q=>q.jobId===req.params.jobId)+1 });
    if (j.status==='done'||j.status==='error'||j.status==='cancelled') { clearInterval(iv); res.end(); }
  }, 400);

  req.on('close', () => clearInterval(iv));
});

// ── File delivery (range-request aware — fixes Chrome partial/corrupt downloads) ─
app.get('/api/dl/:token', (req, res) => {
  const meta = dlTokens.get(req.params.token);
  if (!meta) return res.status(410).send('Link expired or not found.');
  if (meta.expires < Date.now()) {
    dlTokens.delete(req.params.token);
    fs.unlink(meta.filePath, () => {});
    return res.status(410).send('Download link expired.');
  }
  if (!fs.existsSync(meta.filePath)) {
    dlTokens.delete(req.params.token);
    return res.status(404).send('File no longer on server.');
  }

  const fileSize = meta.size;
  const rangeHeader = req.headers['range'];

  // Always set these headers
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`);
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range');

  if (rangeHeader) {
    // Chrome often sends a Range request — honour it properly
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    if (start >= fileSize || end >= fileSize) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).send('Range Not Satisfiable');
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    const stream = fs.createReadStream(meta.filePath, { start, end });
    stream.pipe(res);
    stream.on('error', err => {
      console.error('[stream range]', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    req.on('close', () => stream.destroy());

  } else {
    // Full file delivery
    res.setHeader('Content-Length', fileSize);
    const stream = fs.createReadStream(meta.filePath);
    stream.pipe(res);
    stream.on('end', () => {
      // Clean up after a short delay in case of retry
      setTimeout(() => { fs.unlink(meta.filePath, () => {}); dlTokens.delete(req.params.token); }, 10000);
    });
    stream.on('error', err => {
      console.error('[stream]', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    req.on('close', () => stream.destroy());
  }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  // Return history for this session only, most recent first, max 50
  const filtered = history
    .filter(h => !sessionId || h.sessionId===sessionId)
    .slice(-50).reverse();
  res.json({ history: filtered });
});

app.delete('/api/history', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    history = history.filter(h => h.sessionId !== sessionId);
  } else {
    history = [];
  }
  saveJSON(HIST_FILE, history);
  res.json({ ok:true });
});

// ── Network IP ────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family==='IPv4'&&!i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ── Push notification helper ───────────────────────────────────────────────────
async function sendPush(sessionId, payload) {
  if (!webpush || !VAPID_KEYS.publicKey) return;
  const sub = pushSubs[sessionId];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch(e) {
    // 410 Gone = subscription expired/unsubscribed — clean it up
    if (e.statusCode === 410 || e.statusCode === 404) {
      delete pushSubs[sessionId];
      saveJSON(SUBS_FILE, pushSubs);
    }
    // Don't crash the download on push failure
  }
}

// ── Service Worker (served as real JS file so push scope = origin) ────────────
// Chrome requires the SW to be served from the same origin (not a blob: URL)
// for push subscriptions to work. We serve sw.js directly from disk.
const SW_FILE = path.join(__dirname, 'sw.js');
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  if (fs.existsSync(SW_FILE)) return res.sendFile(path.resolve(SW_FILE));
  res.status(404).send('// sw.js not written yet — restart the server');
});

// ── Push API endpoints ─────────────────────────────────────────────────────────
// Get VAPID public key so the browser can subscribe
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_KEYS.publicKey) return res.status(503).json({ error:'Push not configured' });
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

// Save a push subscription for this session
app.post('/api/push/subscribe', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error:'X-Session-Id required' });
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error:'subscription required' });
  pushSubs[sessionId] = subscription;
  saveJSON(SUBS_FILE, pushSubs);
  console.log(`[PUSH] Subscription saved — session ${sessionId.substring(0,8)}…`);
  res.json({ ok: true });
});

// Remove push subscription
app.delete('/api/push/subscribe', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId && pushSubs[sessionId]) {
    delete pushSubs[sessionId];
    saveJSON(SUBS_FILE, pushSubs);
  }
  res.json({ ok: true });
});

// ── Cancel job ────────────────────────────────────────────────────────────────
app.delete('/api/job/:jobId', (req,res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error:'Job not found' });
  if (job.status === 'done') return res.status(400).json({ error:'Job already completed' });
  if (job.status === 'cancelled') return res.json({ ok:true, message:'Already cancelled' });

  // Kill the yt-dlp process if it is running
  const proc = activeProcs.get(jobId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    activeProcs.delete(jobId);
  }

  // Remove from queue if it hasn't started yet
  const qi = queue.findIndex(q => q.jobId === jobId);
  if (qi !== -1) queue.splice(qi, 1);

  // Clean up any partial tmp files
  if (job.outBase) {
    try {
      fs.readdirSync(path.dirname(job.outBase))
        .filter(f => f.startsWith(path.basename(job.outBase)))
        .forEach(f => fs.unlink(path.join(path.dirname(job.outBase), f), ()=>{}));
    } catch {}
  }

  patchJob(jobId, { status:'cancelled', progress:0, message:'Cancelled by user', error:null });
  saveJSON(JOBS_FILE, jobs);
  console.log(`[CANCEL] Job ${jobId} — ${job.title||job.url}`);
  res.json({ ok:true, message:'Download cancelled' });
});

// ── Cancel ALL active jobs for a session ──────────────────────────────────────
app.delete('/api/jobs', (req,res) => {
  const sessionId = req.headers['x-session-id'];
  let count = 0;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (sessionId && job.sessionId !== sessionId) continue;
    if (job.status === 'done' || job.status === 'cancelled' || job.status === 'error') continue;

    const proc = activeProcs.get(jobId);
    if (proc) { try { proc.kill('SIGTERM'); } catch {} activeProcs.delete(jobId); }

    const qi = queue.findIndex(q => q.jobId === jobId);
    if (qi !== -1) queue.splice(qi, 1);

    if (job.outBase) {
      try {
        fs.readdirSync(path.dirname(job.outBase))
          .filter(f => f.startsWith(path.basename(job.outBase)))
          .forEach(f => fs.unlink(path.join(path.dirname(job.outBase), f), ()=>{}));
      } catch {}
    }

    patchJob(jobId, { status:'cancelled', progress:0, message:'Cancelled by user' });
    count++;
  }
  saveJSON(JOBS_FILE, jobs);
  console.log(`[CANCEL ALL] ${count} job(s) cancelled — session ${sessionId||'all'}`);
  res.json({ ok:true, cancelled: count });
});

// ── Session jobs (for page-refresh reconnect) ─────────────────────────────────
// Returns all non-expired jobs for a session so the frontend can re-attach SSE
app.get('/api/sessions/:sessionId/jobs', (req,res) => {
  const { sessionId } = req.params;
  const cutoff = Date.now() - 30*60*1000;  // ignore jobs older than 30 min
  const result = Object.entries(jobs)
    .filter(([,j]) => j.sessionId === sessionId && j.created > cutoff)
    .map(([jobId,j]) => ({
      jobId,
      status:    j.status,
      progress:  j.progress,
      message:   j.message,
      title:     j.title,
      type:      j.type,
      token:     j.token,
      filename:  j.filename,
      size_h:    j.size_h,
      error:     j.error,
    }));
  res.json({ jobs: result });
});

// ── Write sw.js to disk ───────────────────────────────────────────────────────
// Extracts the SW source embedded in index.html and saves it as /sw.js
// so the browser can register it from the real origin (required for push in Chrome)
function writeSWFile() {
  try {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      console.warn('[SW] index.html not found — sw.js not written');
      return;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    // Extract content between const SW_SRC = ` ... `;
    const match = html.match(/const SW_SRC\s*=\s*`([\s\S]*?)`;/);
    if (!match) {
      console.warn('[SW] Could not find SW_SRC in index.html — sw.js not written');
      return;
    }
    const swSource = match[1];
    fs.writeFileSync(SW_FILE, swSource, 'utf8');
    console.log('[SW] sw.js written to disk ✓');
  } catch (e) {
    console.warn('[SW] Failed to write sw.js:', e.message);
  }
}

// ── Startup recovery ──────────────────────────────────────────────────────────
// After a crash/restart any job still marked running/pending never finished.
// Re-queue them so the download continues automatically.
function recoverJobs() {
  const stuck = Object.entries(jobs).filter(([,j]) =>
    (j.status === 'running' || j.status === 'pending') &&
    j.url && j.format_id && j.outBase
  );
  if (!stuck.length) return;
  console.log(`[RECOVERY] Re-queuing ${stuck.length} interrupted job(s)…`);

  for (const [jobId, j] of stuck) {
    // If the output file already exists the download actually finished before
    // the crash — just mark it done with a fresh token so the user can grab it.
    const existingFiles = (() => {
      try { return fs.readdirSync(path.dirname(j.outBase))
              .filter(f => f.startsWith(path.basename(j.outBase))); }
      catch { return []; }
    })();
    if (existingFiles.length) {
      const filePath = path.join(path.dirname(j.outBase), existingFiles[0]);
      const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
      if (size > 1024) {
        const ext      = path.extname(filePath).replace('.','') || (j.type==='mp3'?'mp3':'mp4');
        const mime     = ext==='mp3' ? 'audio/mpeg' : 'video/mp4';
        const filename = `${sanitize(j.title||'download')}.${ext}`;
        const token    = makeToken();
        dlTokens.set(token, { filePath, filename, mime, size, expires: Date.now()+15*60*1000 });
        patchJob(jobId, { status:'done', progress:100,
          message:`Recovered: ${filename}`, token, filename, size,
          size_h:`${(size/1024/1024).toFixed(1)} MB` });
        saveJSON(JOBS_FILE, jobs);
        console.log(`[RECOVERY] Job ${jobId} — file found, marked done (${filename})`);
        continue;
      }
    }

    // File not found — re-run the download from scratch
    patchJob(jobId, { status:'pending', progress:0, message:'Server restarted — re-queuing…' });
    const { url, format_id, type, title, outBase, sessionId } = j;
    const cf = cookieFile(sessionId);
    const cookiesArg = (cf && fs.existsSync(cf)) ? [cf] : [];

    enqueue(jobId, async () => {
      function up(patch) { patchJob(jobId, patch); }

      function onStderr(line) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = Math.min(90, Math.round(parseFloat(m[1])*0.85+5));
          up({ progress:pct, message:`Downloading… ${parseFloat(m[1]).toFixed(1)}%` });
        }
        if (line.includes('[Merger]')||line.includes('Merging'))
          up({ progress:92, message:'Merging streams…' });
        if (line.includes('[ffmpeg]')||line.includes('Remux'))
          up({ progress:95, message:'Remuxing…' });
      }

      try {
        let result;
        if (type === 'mp3') {
          up({ message:'Downloading audio…', progress:5 });
          result = await runFetcher(
            ['audio', url, outBase+'.mp3', ...cookiesArg], 1800000, onStderr,
            proc => activeProcs.set(jobId, proc)
          );
        } else {
          up({ message:'Downloading video…', progress:5 });
          result = await runFetcher(
            ['dl', url, format_id, outBase, ...cookiesArg], 3600000, onStderr,
            proc => activeProcs.set(jobId, proc)
          );
        }
        activeProcs.delete(jobId);

        const filePath = result.path;
        if (!fs.existsSync(filePath)) throw new Error('Output file not found');
        const size = fs.statSync(filePath).size;
        if (size < 1024) throw new Error(`File too small (${size}B)`);

        const ext      = path.extname(filePath).replace('.','') || (type==='mp3'?'mp3':'mp4');
        const mime     = ext==='mp3' ? 'audio/mpeg' : 'video/mp4';
        const safeTitle= sanitize(title||'download');
        const filename = `${safeTitle}.${ext}`;
        const token    = makeToken();

        dlTokens.set(token, { filePath, filename, mime, size, expires: Date.now()+15*60*1000 });
        up({ status:'done', progress:100, message:`Ready: ${filename}`, token, filename, size, size_h:result.size_h });

        history.push({ id:jobId, title:safeTitle, filename, ext, size, size_h:result.size_h,
          url, ts:Date.now(), sessionId: sessionId||null });
        saveJSON(HIST_FILE, history);
        console.log(`[RECOVERY DONE] ${filename} — ${result.size_h}`);
      } catch(e) {
        activeProcs.delete(jobId);
        if (jobs[jobId]?.status === 'cancelled') { saveJSON(JOBS_FILE, jobs); return; }
        console.error('[RECOVERY ERR]', jobId, e);
        up({ status:'error', progress:0, message:'Failed after restart', error:String(e).substring(0,500) });
      }
    });
    console.log(`[RECOVERY] Job ${jobId} — re-queued (${url.substring(0,60)})`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();

  // Write sw.js to disk so Chrome can register it with proper origin scope
  // (blob: URL registrations don't work for push notifications in Chrome)
  writeSWFile();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 NexLoad v5.0 — ${os.cpus().length} CPU cores detected`);
  console.log(`   Concurrent fragments: ${Math.min(Math.max(os.cpus().length,2),8)}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`💻 This PC:  http://localhost:${PORT}`);
  console.log(`📱 Wi-Fi:    http://${ip}:${PORT}`);
  console.log(`📊 Status:   http://localhost:${PORT}/api/status`);
  console.log(`${'='.repeat(50)}\n`);
  recoverJobs();   // ← re-queue any jobs interrupted by previous crash/restart
});
