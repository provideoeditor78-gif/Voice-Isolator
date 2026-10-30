/* installer.js - runtime (Python + AI models + FFmpeg) ko online se download karke install karta hai.
 *
 * Pack descriptor (server par):  <baseUrl>/<packId>.json
 *   { "id":"win-gpu", "version":"1.0.0", "file":"win-gpu-1.0.0.tar.gz", "sha256":"...", "size":123 }
 * Pack file:                     <baseUrl>/<file>
 *
 * Runtime install hota hai:  <USER_DATA>/VoiceSeparator/runtime/{python,models,bin}
 */
var VSInstaller = (function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var urlLib = require('url');
  var https = require('https');
  var http = require('http');
  var crypto = require('crypto');
  var cp = require('child_process');

  var cs = new CSInterface();
  var isWin = process.platform === 'win32';
  var isMac = process.platform === 'darwin';

  /* ---------- paths ---------- */

  function baseDir() { return path.join(cs.getSystemPath(SystemPath.USER_DATA), 'VoiceSeparator'); }
  function runtimeDir() { return path.join(baseDir(), 'runtime'); }
  function enginePath() { return path.join(cs.getSystemPath(SystemPath.EXTENSION), 'engine', 'engine.py'); }
  function pythonPath() {
    return isWin ? path.join(runtimeDir(), 'python', 'python.exe')
                 : path.join(runtimeDir(), 'python', 'bin', 'python3');
  }
  function ffmpegPath() {
    return isWin ? path.join(runtimeDir(), 'bin', 'ffmpeg.exe') : path.join(runtimeDir(), 'bin', 'ffmpeg');
  }

  /* ---------- small helpers ---------- */

  function mkdirp(dir) {
    if (fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir));
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }

  function rmrf(dir) {
    return new Promise(function (resolve, reject) {
      if (!fs.existsSync(dir)) return resolve();
      var cmd = isWin ? 'cmd.exe' : 'rm';
      var args = isWin ? ['/c', 'rmdir', '/s', '/q', dir] : ['-rf', dir];
      cp.execFile(cmd, args, { windowsHide: true }, function (err) {
        if (err && fs.existsSync(dir)) reject(new Error('Could not remove old files: ' + dir)); else resolve();
      });
    });
  }

  function fileSize(f) { try { return fs.statSync(f).size; } catch (e) { return -1; } }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function readJSONFile(f) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
  }

  function readInstalled() { return readJSONFile(path.join(runtimeDir(), 'installed.json')); }

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '';
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function friendlyError(e) {
    var m = (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);
    var c = e && e.code;
    if (c === 'ENOTFOUND' || c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || c === 'ECONNRESET' || c === 'EAI_AGAIN') {
      return 'Cannot reach the download server. Check your internet connection and try again.';
    }
    if (c === 'ENOSPC') return 'Not enough free disk space. Free up some space and try again.';
    if (c === 'EACCES' || c === 'EPERM' || c === 'EBUSY') {
      return 'The system blocked writing the files (antivirus or permissions). Allow the app and try again.';
    }
    return m;
  }

  /* ---------- platform / GPU detection ---------- */

  function nvidiaInfo() {
    var sysRoot = process.env.SystemRoot || 'C:\\Windows';
    var cands = ['nvidia-smi',
      path.join(sysRoot, 'System32', 'nvidia-smi.exe'),
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
    function tryAt(i) {
      if (i >= cands.length) return Promise.resolve(null);
      return new Promise(function (resolve) {
        cp.execFile(cands[i], ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
          { timeout: 8000, windowsHide: true }, function (err, out) {
            if (err || !out) return resolve(null);
            var p = out.split(/\r?\n/)[0].split(',').map(function (s) { return s.trim(); });
            if (p.length < 3) return resolve(null);
            resolve({ name: p[0], driver: parseFloat(p[1]), vramMB: parseInt(p[2], 10) });
          });
      }).then(function (r) { return r || tryAt(i + 1); });
    }
    return tryAt(0);
  }

  function macIsArm() {
    return new Promise(function (resolve) {
      cp.execFile('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 5000 }, function (err, out) {
        resolve(!err && String(out).trim() === '1');
      });
    });
  }

  // -> { platform, packs:[{id,label}], recommended, summary, warning }
  function detect() {
    if (isWin) {
      return nvidiaInfo().then(function (g) {
        var packs = [
          { id: 'win-gpu', label: 'NVIDIA GPU (faster, larger download)' },
          { id: 'win-cpu', label: 'CPU only (smaller download)' }
        ];
        var rec = 'win-cpu', summary = 'Windows \u2022 No NVIDIA GPU found', warning = '';
        if (g) {
          summary = 'Windows \u2022 ' + g.name + ' (' + Math.round(g.vramMB / 1024) + ' GB)';
          if (g.driver >= 528 && g.vramMB >= 4000) {
            rec = 'win-gpu';
          } else if (g.driver < 528) {
            warning = 'Your NVIDIA driver (' + g.driver + ') is too old for GPU mode. Update it to use the GPU. CPU pack selected.';
          } else {
            warning = 'GPU has less than 4 GB memory. CPU pack selected.';
          }
        }
        return { platform: 'win', packs: packs, recommended: rec, summary: summary, warning: warning };
      });
    }
    if (isMac) {
      return macIsArm().then(function (arm) {
        return {
          platform: 'mac',
          packs: [{ id: 'mac-arm64', label: 'Apple Silicon (M1/M2/M3/M4)' }, { id: 'mac-x64', label: 'Intel Mac' }],
          recommended: arm ? 'mac-arm64' : 'mac-x64',
          summary: 'macOS \u2022 ' + (arm ? 'Apple Silicon' : 'Intel'),
          warning: ''
        };
      });
    }
    return Promise.reject(new Error('This operating system is not supported.'));
  }

  /* ---------- HTTP ---------- */

  function fetchJSON(url, redirects) {
    redirects = redirects || 0;
    return new Promise(function (resolve, reject) {
      var u = urlLib.parse(url);
      var lib = u.protocol === 'http:' ? http : https;
      var req = lib.get({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path,
        headers: { 'User-Agent': 'VoiceSeparator/1.0', 'Cache-Control': 'no-cache' } }, function (res) {
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('Too many redirects'));
          return resolve(fetchJSON(urlLib.resolve(url, res.headers.location), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Server returned ' + res.statusCode + ' for ' + u.pathname));
        }
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function (d) { body += d; });
        res.on('end', function () {
          try { resolve(JSON.parse(body.replace(/^\uFEFF/, ''))); }
          catch (e) { reject(new Error('Invalid response from server.')); }
        });
      });
      req.setTimeout(15000, function () { req.abort(); reject(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })); });
      req.on('error', reject);
    });
  }

  function joinUrl(base, name) { return base.replace(/\/+$/, '') + '/' + name; }

  function fetchPackInfo(base, packId) {
    return fetchJSON(joinUrl(base, packId + '.json')).then(function (info) {
      if (!info || !info.file || !info.sha256 || !info.size) throw new Error('Pack information is incomplete.');
      return info;
    });
  }

  // Ek koshish. 206 resume support karta hai. onProgress(received,total,speed)
  function downloadOnce(url, dest, ctl, onProgress, redirects) {
    return new Promise(function (resolve, reject) {
      if (ctl.aborted) return reject(new Error('Cancelled'));
      var existing = Math.max(0, fileSize(dest));
      var u = urlLib.parse(url);
      var lib = u.protocol === 'http:' ? http : https;
      var headers = { 'User-Agent': 'VoiceSeparator/1.0' };
      if (existing > 0) headers.Range = 'bytes=' + existing + '-';

      var req = lib.get({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, headers: headers },
        function (res) {
          var sc = res.statusCode;
          if ([301, 302, 303, 307, 308].indexOf(sc) >= 0 && res.headers.location) {
            res.resume();
            if ((redirects || 0) > 5) return reject(new Error('Too many redirects'));
            return resolve(downloadOnce(urlLib.resolve(url, res.headers.location), dest, ctl, onProgress, (redirects || 0) + 1));
          }
          if (sc === 416) { res.resume(); return resolve(); }   // file pehle se poori hai
          if (sc !== 200 && sc !== 206) {
            res.resume();
            var he = new Error('Download server returned ' + sc + '.');
            he.fatal = (sc >= 400 && sc < 500);
            return reject(he);
          }

          var received = (sc === 206) ? existing : 0;
          var total = 0;
          if (sc === 206 && res.headers['content-range']) {
            var m = /\/(\d+)$/.exec(res.headers['content-range']);
            if (m) total = parseInt(m[1], 10);
          } else {
            total = parseInt(res.headers['content-length'] || '0', 10);
          }

          var out = fs.createWriteStream(dest, { flags: sc === 206 ? 'a' : 'w' });
          var lastT = Date.now(), lastB = received, speed = 0, settled = false;

          function fail(e) {
            if (settled) return;
            settled = true;
            try { out.destroy(); } catch (x) { /* ignore */ }
            reject(ctl.aborted ? new Error('Cancelled') : e);
          }

          ctl.cancel = function () { try { req.abort(); } catch (x) { /* ignore */ } };

          res.on('data', function (chunk) {
            received += chunk.length;
            var now = Date.now();
            if (now - lastT >= 500) {
              speed = (received - lastB) / ((now - lastT) / 1000);
              lastT = now; lastB = received;
            }
            onProgress(received, total, speed);
          });
          res.on('aborted', function () { fail(Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' })); });
          res.on('error', fail);
          out.on('error', fail);
          out.on('finish', function () {
            if (settled) return;
            if (total && received < total) return fail(Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' }));
            settled = true;
            resolve();
          });
          res.pipe(out);
        });

      req.setTimeout(30000, function () { req.abort(); });
      req.on('error', function (e) { reject(ctl.aborted ? new Error('Cancelled') : e); });
      ctl.cancel = function () { try { req.abort(); } catch (x) { /* ignore */ } };
    });
  }

  // Auto-retry (resume ke saath)
  function download(url, dest, ctl, onProgress) {
    var attempt = 0;
    function go() {
      return downloadOnce(url, dest, ctl, onProgress, 0).catch(function (e) {
        if (ctl.aborted) throw new Error('Cancelled');
        if (e.fatal) throw e;
        attempt++;
        if (attempt > 8) throw e;
        onProgress(null, null, 0, 'Connection lost. Retrying (' + attempt + '/8)\u2026');
        return delay(Math.min(2000 * attempt, 10000)).then(go);
      });
    }
    return go();
  }

  function sha256File(file) {
    return new Promise(function (resolve, reject) {
      var h = crypto.createHash('sha256');
      var s = fs.createReadStream(file);
      s.on('data', function (d) { h.update(d); });
      s.on('error', reject);
      s.on('end', function () { resolve(h.digest('hex')); });
    });
  }

  /* ---------- extract / check ---------- */

  function tarBin() { return isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'; }

  function extract(archive, destDir) {
    return new Promise(function (resolve, reject) {
      mkdirp(destDir);
      cp.execFile(tarBin(), ['-xf', archive, '-C', destDir], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
        function (err, so, se) {
          if (err) return reject(new Error('Could not unpack the files. ' + String(se || err.message).slice(-200)));
          resolve();
        });
    });
  }

  // -> {ok, device, gpu, message}
  function check() {
    return new Promise(function (resolve) {
      var py = pythonPath();
      if (!fs.existsSync(py)) return resolve({ ok: false, message: 'Python not found in runtime.' });
      cp.execFile(py, [enginePath(), '--check', '--runtime', runtimeDir()],
        { timeout: 300000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, function (err, so, se) {
          var lines = String(so || '').trim().split(/\r?\n/);
          var last = lines[lines.length - 1];
          try {
            var j = JSON.parse(last);
            if (j && j.stage === 'check') return resolve(j);
          } catch (e) { /* fall through */ }
          resolve({ ok: false, message: (String(se || '').slice(-300) + ' code=' + (err && err.code)).trim() });
        });
    });
  }

  function runRedist() {
    return new Promise(function (resolve) {
      var exe = path.join(runtimeDir(), 'vc_redist.x64.exe');
      if (!isWin || !fs.existsSync(exe)) return resolve(false);
      var ps = "Start-Process -FilePath '" + exe.replace(/'/g, "''") +
        "' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait";
      cp.execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, function (err) { resolve(!err); });
    });
  }

  /* ---------- full install pipeline ---------- */

  /* o = { packInfo, baseUrl, localFile?, ctl, onStage(name,text), onProgress(recv,total,speed,msg) } */
  function install(o) {
    var info = o.packInfo, ctl = o.ctl;
    var archive, usedLocal = !!o.localFile;
    var chain;

    mkdirp(path.join(baseDir(), 'downloads'));

    if (usedLocal) {
      archive = o.localFile;
      chain = Promise.resolve();
      if (info && path.basename(archive) === info.file) {
        chain = chain.then(function () {
          o.onStage('verify', 'Verifying file\u2026');
          return sha256File(archive).then(function (h) {
            if (h !== String(info.sha256).toLowerCase()) throw new Error('This file is damaged or not the right one.');
          });
        });
      }
    } else {
      archive = path.join(baseDir(), 'downloads', info.file);
      var part = archive + '.part';
      var have = (fileSize(archive) === info.size);
      chain = Promise.resolve();
      if (!have) {
        chain = chain.then(function () {
          o.onStage('download', 'Downloading\u2026');
          return download(joinUrl(o.baseUrl, info.file), part, ctl, o.onProgress);
        }).then(function () {
          if (fs.existsSync(archive)) fs.unlinkSync(archive);
          fs.renameSync(part, archive);
        });
      }
      chain = chain.then(function () {
        o.onStage('verify', 'Verifying download\u2026');
        return sha256File(archive);
      }).then(function (h) {
        if (h !== String(info.sha256).toLowerCase()) {
          try { fs.unlinkSync(archive); } catch (e) { /* ignore */ }
          throw new Error('The downloaded file is damaged. Please press Download to try again.');
        }
      });
    }

    var rt = runtimeDir(), tmp = rt + '.new';

    return chain.then(function () {
      o.onStage('extract', 'Installing\u2026 this can take a few minutes. Please keep this panel open.');
      return rmrf(tmp);
    }).then(function () {
      return extract(archive, tmp);
    }).then(function () {
      return rmrf(rt);
    }).then(function () {
      fs.renameSync(tmp, rt);
      o.onStage('check', 'Testing the installation\u2026');
      return check();
    }).then(function (r) {
      if (r.ok) return r;
      var txt = String(r.message || '');
      if (isWin && /DLL|0xC0000135|3221225781|VCRUNTIME|MSVCP|c0000135/i.test(txt)) {
        o.onStage('redist', 'Installing Windows components (allow the prompt)\u2026');
        return runRedist().then(function () { return check(); });
      }
      return r;
    }).then(function (r) {
      if (!r.ok) throw new Error('Setup test failed: ' + (r.message || 'unknown error'));
      var packId = info ? info.id : (readJSONFile(path.join(rt, 'pack.json')) || {}).id;
      var version = info ? info.version : (readJSONFile(path.join(rt, 'pack.json')) || {}).version;
      fs.writeFileSync(path.join(rt, 'installed.json'),
        JSON.stringify({ packId: packId, version: version, installedAt: new Date().toISOString() }));
      if (!usedLocal) { try { fs.unlinkSync(archive); } catch (e) { /* ignore */ } }
      return { packId: packId, version: version, device: r.device, gpu: r.gpu };
    });
  }

  return {
    runtimeDir: runtimeDir, pythonPath: pythonPath, ffmpegPath: ffmpegPath, enginePath: enginePath,
    readInstalled: readInstalled, detect: detect, fetchPackInfo: fetchPackInfo,
    install: install, fmtBytes: fmtBytes, friendlyError: friendlyError
  };
})();
