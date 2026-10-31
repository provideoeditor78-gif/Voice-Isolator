/* license.js - license key activation (WordPress plugin "AsadFX License Server" se baat karta hai)
 *
 * Flow: key dalo -> server key check karta hai (Gumroad ya manual) aur is computer se bind karta hai
 *       -> signed token milta hai -> token file mein save -> offline chalta hai
 *       -> token expire hone se pehle panel khud internet se renew karta hai.
 */
var VSLicense = (function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var crypto = require('crypto');
  var cp = require('child_process');
  var urlLib = require('url');
  var https = require('https');
  var http = require('http');

  var cs = new CSInterface();
  var isWin = process.platform === 'win32';
  var isMac = process.platform === 'darwin';
  var DAY = 86400;
  var RENEW_BEFORE = 7 * DAY;
  var machineCache = null;

  /* ---------- config / paths ---------- */

  function config() {
    try {
      return JSON.parse(fs.readFileSync(path.join(cs.getSystemPath(SystemPath.EXTENSION), 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) { return {}; }
  }
  function required() { return config().licenseRequired !== false; }
  function product() { return config().productCode || 'voiceisolator'; }
  function buyUrl() { return config().buyUrl || ''; }
  function apiBase() {
    var u = config().licenseApi || '';
    if (!u || /YOUR-SITE/i.test(u)) {
      throw new Error('License server address is not set. (Developer: set "licenseApi" in config.json)');
    }
    return u.replace(/\/+$/, '') + '/';
  }
  function dir() { return path.join(cs.getSystemPath(SystemPath.USER_DATA), 'VoiceSeparator'); }
  function licFile() { return path.join(dir(), 'license.json'); }

  function mkdirp(d) {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  function now() { return Math.floor(Date.now() / 1000); }
  function readLic() {
    try { return JSON.parse(fs.readFileSync(licFile(), 'utf8')); } catch (e) { return null; }
  }
  function writeLic(o) {
    mkdirp(dir());
    var tmp = licFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o));
    if (fs.existsSync(licFile())) fs.unlinkSync(licFile());
    fs.renameSync(tmp, licFile());
  }
  function clearLic() { try { fs.unlinkSync(licFile()); } catch (e) { /* ignore */ } }

  function normKey(k) { return String(k || '').replace(/\s+/g, '').toUpperCase(); }
  function hint(k) { return '****' + normKey(k).slice(-4); }

  /* ---------- machine id ---------- */

  function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

  function fallbackId() {
    var f = path.join(dir(), 'machine.id');
    try { var v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch (e) { /* create */ }
    var id = crypto.randomBytes(16).toString('hex');
    try { mkdirp(dir()); fs.writeFileSync(f, id); } catch (e) { /* ignore */ }
    return id;
  }

  function machineId() {
    if (machineCache) return Promise.resolve(machineCache);
    return new Promise(function (resolve) {
      if (isWin) {
        cp.execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
          { windowsHide: true, timeout: 8000 }, function (err, out) {
            var m = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(String(out || ''));
            resolve(m ? m[1].trim() : null);
          });
      } else if (isMac) {
        cp.execFile('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 8000 }, function (err, out) {
          var m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(String(out || ''));
          resolve(m ? m[1] : null);
        });
      } else { resolve(null); }
    }).then(function (raw) {
      machineCache = sha256hex('VS1|' + (raw || fallbackId()));
      return machineCache;
    });
  }

  /* ---------- HTTP ---------- */

  function request(method, route, body) {
    return new Promise(function (resolve, reject) {
      var url;
      try { url = apiBase() + route; } catch (e) { return reject(e); }
      var u = urlLib.parse(url);
      var lib = u.protocol === 'http:' ? http : https;
      var data = body ? JSON.stringify(body) : null;
      var headers = { 'User-Agent': 'VoiceSeparator/1.0', 'Accept': 'application/json' };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      var req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, method: method, headers: headers },
        function (res) {
          var buf = '';
          res.setEncoding('utf8');
          res.on('data', function (d) { buf += d; });
          res.on('end', function () {
            var j;
            try { j = JSON.parse(buf.replace(/^\uFEFF/, '')); } catch (e) {
              var pe = new Error('The license server sent an unexpected reply (HTTP ' + res.statusCode + '). Check the license address in config.json.');
              pe.network = true;
              return reject(pe);
            }
            resolve(j);
          });
        });
      req.setTimeout(15000, function () { req.abort(); });
      req.on('error', function (e) {
        var ne = new Error('Cannot reach the license server. Check your internet connection.');
        ne.network = true; ne.code = e.code;
        reject(ne);
      });
      if (data) req.write(data);
      req.end();
    });
  }

  function fail(res, fallbackMsg) {
    var e = new Error((res && res.message) || fallbackMsg || 'License check failed.');
    e.code = res && res.code;
    return e;
  }

  /* ---------- token ---------- */

  function b64urlToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
  }

  // -> {ok, exp}
  function verifyToken(token, pubkey, machine) {
    try {
      var parts = String(token).split('.');
      if (parts.length !== 2 || !pubkey) return { ok: false };
      var v = crypto.createVerify('RSA-SHA256');
      v.update(parts[0]);
      if (!v.verify(pubkey, b64urlToBuf(parts[1]))) return { ok: false };
      var p = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
      if (p.m !== machine || p.p !== product() || !p.exp) return { ok: false };
      return { ok: true, exp: p.exp };
    } catch (e) { return { ok: false }; }
  }

  /* ---------- public API ---------- */

  // -> {state:'valid'|'none'|'expired'|'invalid', hint, exp, daysLeft, renewSoon, disabled}
  function check() {
    if (!required()) return Promise.resolve({ state: 'valid', disabled: true });
    var lic = readLic();
    if (!lic || !lic.key || !lic.token) return Promise.resolve({ state: 'none' });
    return machineId().then(function (machine) {
      if (lic.machine !== machine) return { state: 'invalid', message: 'This license belongs to a different computer.' };
      var t = verifyToken(lic.token, lic.pubkey, machine);
      if (!t.ok) return { state: 'invalid', message: 'License file is damaged. Please activate again.' };
      var n = now();
      if (lic.lastSeen && n < lic.lastSeen - DAY) {
        return { state: 'invalid', message: 'Your computer clock looks wrong. Fix the date and time, then try again.' };
      }
      if (n >= t.exp) return { state: 'expired', hint: hint(lic.key), exp: t.exp };
      if (!lic.lastSeen || n > lic.lastSeen + 3600) { lic.lastSeen = n; try { writeLic(lic); } catch (e) { /* ignore */ } }
      return { state: 'valid', hint: hint(lic.key), exp: t.exp, daysLeft: Math.ceil((t.exp - n) / DAY), renewSoon: (t.exp - n) < RENEW_BEFORE };
    });
  }

  function activate(rawKey) {
    var key = String(rawKey || '').trim();
    if (!normKey(key)) return Promise.reject(new Error('Please enter your license key.'));
    var machine;
    return machineId().then(function (m) {
      machine = m;
      return request('GET', 'pubkey');
    }).then(function (pk) {
      if (!pk || !pk.public_key) throw new Error('License server is not ready (no public key). Contact support.');
      return request('POST', 'activate', { key: key, machine_id: machine, machine_name: os.hostname() })
        .then(function (res) {
          if (!res || !res.ok) throw fail(res, 'Activation failed.');
          var t = verifyToken(res.token, pk.public_key, machine);
          if (!t.ok) throw new Error('The license server reply could not be verified. Contact support.');
          writeLic({ key: normKey(key), token: res.token, pubkey: pk.public_key, machine: machine, lastSeen: now() });
          return { hint: hint(key), exp: t.exp };
        });
    });
  }

  function renew() {
    var lic = readLic();
    if (!lic) return Promise.reject(new Error('No license.'));
    return machineId().then(function (machine) {
      return request('POST', 'validate', { key: lic.key, machine_id: machine }).then(function (res) {
        if (res && res.ok) {
          var t = verifyToken(res.token, lic.pubkey, machine);
          if (!t.ok) throw new Error('The license server reply could not be verified.');
          lic.token = res.token; lic.lastSeen = now();
          writeLic(lic);
          return { exp: t.exp };
        }
        // Server ne saaf mana kiya: license hata do
        if (res && (res.code === 'revoked' || res.code === 'invalid_key' || res.code === 'machine_mismatch')) clearLic();
        throw fail(res, 'License check failed.');
      });
    });
  }

  // Panel kholte waqt: valid ho to chalne do, expire ho gaya to renew try karo
  function ensure() {
    return check().then(function (st) {
      if (st.disabled) return st;
      if (st.state === 'valid') {
        if (st.renewSoon) renew().catch(function () { /* offline: koi masla nahi */ });
        return st;
      }
      if (st.state === 'expired') {
        return renew().then(function () { return check(); }, function (e) {
          return { state: e.network ? 'expired' : 'none', message: e.message, hint: st.hint };
        });
      }
      return st;
    });
  }

  function deactivate() {
    var lic = readLic();
    if (!lic) return Promise.resolve();
    return machineId().then(function (machine) {
      return request('POST', 'deactivate', { key: lic.key, machine_id: machine });
    }).then(function (res) {
      if (res && res.ok === false && res.code !== 'invalid_key') throw fail(res, 'Could not deactivate.');
      clearLic();
    });
  }

  return {
    check: check, ensure: ensure, activate: activate, renew: renew, deactivate: deactivate,
    buyUrl: buyUrl, required: required
  };
})();
