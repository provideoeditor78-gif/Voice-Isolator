/* Voice Isolator panel logic.
 * 1) Pehli dafa: "Download essential files" -> runtime install (installer.js)
 * 2) Phir: source chuno -> engine chalao -> results project mein import
 */
(function () {
  'use strict';

  var cs = new CSInterface();
  var fs = require('fs');
  var path = require('path');
  var spawn = require('child_process').spawn;

  var extPath = cs.getSystemPath(SystemPath.EXTENSION);
  var state = { src: null, proc: null, cancelled: false, installing: false, ctl: null, packInfo: null, reinstall: false };

  function $(id) { return document.getElementById(id); }

  /* ---------- config ---------- */

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(extPath, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { return {}; }
  }

  function baseUrl() {
    var u = readConfig().baseUrl || '';
    if (!u || /YOUR-HOST/i.test(u)) {
      throw new Error('Download address is not set. (Developer: set "baseUrl" in config.json)');
    }
    return u;
  }

  /* ---------- views ---------- */

  function showView(name) {
    $('viewLicense').style.display = (name === 'license') ? '' : 'none';
    $('viewSetup').style.display = (name === 'setup') ? '' : 'none';
    $('viewMain').style.display = (name === 'main') ? '' : 'none';
  }

  function setStatus(msg, cls) {
    var el = $('status');
    el.textContent = msg;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function setProgress(p) { $('barFill').style.width = Math.max(0, Math.min(100, p)) + '%'; }

  function setBusy(busy) {
    $('btnRun').style.display = busy ? 'none' : '';
    $('btnCancel').style.display = busy ? '' : 'none';
    $('btnSelected').disabled = busy;
    $('btnBrowse').disabled = busy;
  }

  function setSource(p) {
    state.src = p;
    var el = $('srcName');
    el.textContent = p ? path.basename(p) : 'No file selected';
    el.title = p || '';
    el.className = 'src' + (p ? '' : ' empty');
    $('btnRun').disabled = !p;
  }

  /* ---------- setup / download ---------- */

  function setSetupStatus(msg, cls) {
    var el = $('setupStatus');
    el.textContent = msg || '\u00a0';
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function setSetupBusy(busy) {
    state.installing = busy;
    $('btnInstall').style.display = busy ? 'none' : '';
    $('btnInstallCancel').style.display = busy ? '' : 'none';
    $('packSelect').disabled = busy;
    $('lnkLocal').style.display = busy ? 'none' : '';
  }

  function loadPackInfo(id) {
    state.packInfo = null;
    $('btnInstall').disabled = true;
    $('dlSize').textContent = 'Checking download\u2026';
    var url;
    try { url = baseUrl(); } catch (e) { $('dlSize').textContent = ''; setSetupStatus(e.message, 'err'); return Promise.resolve(); }
    return VSInstaller.fetchPackInfo(url, id).then(function (info) {
      state.packInfo = info;
      $('dlSize').textContent = 'Download size: ' + VSInstaller.fmtBytes(info.size) + '  \u2022  version ' + info.version;
      $('btnInstall').disabled = false;
      setSetupStatus('');
    }).catch(function (e) {
      $('dlSize').textContent = '';
      setSetupStatus(VSInstaller.friendlyError(e), 'err');
    });
  }

  function initSetup(reinstall) {
    state.reinstall = !!reinstall;
    showView('setup');
    $('lnkBack').style.display = reinstall ? '' : 'none';
    $('detectInfo').textContent = 'Checking\u2026';
    $('detectWarn').textContent = '';
    $('dlSize').textContent = '';
    setSetupStatus('');
    setSetupBusy(false);
    $('btnInstall').disabled = true;
    $('setupFill').style.width = '0';

    VSInstaller.detect().then(function (d) {
      $('detectInfo').textContent = d.summary;
      $('detectWarn').textContent = d.warning || '';
      var sel = $('packSelect');
      sel.innerHTML = '';
      d.packs.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.label;
        if (p.id === d.recommended) o.selected = true;
        sel.appendChild(o);
      });
      sel.disabled = false;
      return loadPackInfo(d.recommended);
    }).catch(function (e) {
      $('detectInfo').textContent = 'Could not check your computer.';
      setSetupStatus(VSInstaller.friendlyError(e), 'err');
    });
  }

  function startInstall(localFile) {
    if (state.installing) return;
    var url;
    try { url = baseUrl(); } catch (e) { if (!localFile) { setSetupStatus(e.message, 'err'); return; } url = ''; }
    if (!localFile && !state.packInfo) return;

    var ctl = { aborted: false, cancel: null };
    state.ctl = ctl;
    setSetupBusy(true);
    setSetupStatus('Starting\u2026');
    $('setupFill').style.width = '1%';

    VSInstaller.install({
      packInfo: state.packInfo,
      baseUrl: url,
      localFile: localFile || null,
      ctl: ctl,
      onStage: function (name, text) {
        setSetupStatus(text);
        if (name !== 'download') $('setupFill').style.width = '100%';
      },
      onProgress: function (recv, total, speed, msg) {
        if (msg) { setSetupStatus(msg); return; }
        var pct = total ? (recv / total) * 100 : 0;
        $('setupFill').style.width = pct + '%';
        setSetupStatus(Math.floor(pct) + '%  \u2022  ' + VSInstaller.fmtBytes(speed) + '/s  \u2022  ' +
          VSInstaller.fmtBytes(recv) + ' of ' + VSInstaller.fmtBytes(total));
      }
    }).then(function (res) {
      setSetupBusy(false);
      enterMain();
      setStatus('Setup complete' + (res.device === 'cuda' ? ' (GPU mode).' : '.'), 'ok');
    }).catch(function (e) {
      setSetupBusy(false);
      if (e.message === 'Cancelled') {
        setSetupStatus('Paused. Press "Download essential files" to continue where it stopped.');
      } else {
        $('setupFill').style.width = '0';
        setSetupStatus(VSInstaller.friendlyError(e), 'err');
      }
    });
  }

  function cancelInstall() {
    if (!state.ctl) return;
    state.ctl.aborted = true;
    if (state.ctl.cancel) state.ctl.cancel();
  }

  function installFromFile() {
    var r = window.cep.fs.showOpenDialogEx(false, false, 'Select the downloaded pack file', '', ['gz', 'tgz']);
    if (r && r.data && r.data.length) startInstall(r.data[0]);
  }

  /* ---------- enter main view / updates ---------- */

  function enterMain() {
    showView('main');
    refreshLicenseInfo();
    var inst = VSInstaller.readInstalled() || {};
    $('rtInfo').textContent = 'Panel v1.3.0  \u2022  Engine: ' + (inst.packId || 'dev') + (inst.version ? ' v' + inst.version : '');
    $('btnUpdate').style.display = 'none';

    if (inst.packId && inst.version) {
      try {
        VSInstaller.fetchPackInfo(baseUrl(), inst.packId).then(function (info) {
          if (info.version !== inst.version) {
            state.packInfo = info;
            $('btnUpdate').textContent = 'Update available (v' + info.version + ')';
            $('btnUpdate').style.display = '';
          }
        }).catch(function () { /* offline: koi masla nahi */ });
      } catch (e) { /* baseUrl set nahi */ }
    }
  }

  function isInstalled() {
    if (readConfig().devPython) return true;
    return !!VSInstaller.readInstalled();
  }

  /* ---------- Host (JSX) bridge ---------- */

  function callHost(fn, arg) {
    return new Promise(function (resolve, reject) {
      var script = fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
      cs.evalScript(script, function (res) {
        var o;
        try { o = JSON.parse(res); } catch (e) {
          return reject(new Error('Host script error: ' + res));
        }
        if (o.ok) resolve(o); else reject(new Error(o.error));
      });
    });
  }

  /* ---------- Engine ---------- */

  function resolveEngine() {
    var cfg = readConfig();
    var rt = VSInstaller.runtimeDir();
    var ff = VSInstaller.ffmpegPath();
    var py = cfg.devPython || VSInstaller.pythonPath();
    if (!fs.existsSync(ff)) ff = cfg.ffmpeg || 'ffmpeg';
    return { cmd: py, args: [VSInstaller.enginePath()], ffmpeg: ff, runtime: rt };
  }

  var STAGE_LABEL = {
    convert: 'Reading audio\u2026',
    separate: 'Separating voice and music\u2026',
    denoise: 'Removing noise\u2026',
    noise: 'Extracting noise layer\u2026',
    enhance: 'Polishing voice\u2026',
    export: 'Saving files\u2026'
  };

  function runEngine(src, outDir, strength, enhance, enhParams, onProgress) {
    return new Promise(function (resolve, reject) {
      var eng = resolveEngine();
      var args = eng.args.concat([src, '-o', outDir, '--strength', String(strength),
        '--enhance', enhance, '--enhance-params', JSON.stringify(enhParams || {}),
        '--ffmpeg', eng.ffmpeg, '--runtime', eng.runtime]);
      var child;
      try { child = spawn(eng.cmd, args, { windowsHide: true }); }
      catch (e) { return reject(new Error('Could not start engine: ' + e.message)); }

      state.proc = child;
      var buf = '', errTail = '', result = null, engineError = null, warnings = [];

      child.on('error', function (e) {
        reject(new Error('Could not start engine (' + eng.cmd + '): ' + e.message));
      });

      child.stdout.on('data', function (d) {
        buf += d.toString();
        var lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(function (line) {
          line = line.trim();
          if (!line) return;
          var m;
          try { m = JSON.parse(line); } catch (e) { return; }
          if (m.stage === 'error') engineError = m.message;
          else if (m.stage === 'done') result = m.files;
          else if (m.stage === 'warn') warnings.push(m.message);
          else onProgress(m);
        });
      });

      child.stderr.on('data', function (d) { errTail = (errTail + d.toString()).slice(-500); });

      child.on('close', function (code) {
        state.proc = null;
        if (state.cancelled) return reject(new Error('Cancelled'));
        if (result) { result.__warnings = warnings; return resolve(result); }
        reject(new Error(engineError || errTail || ('Engine exited with code ' + code)));
      });
    });
  }

  /* ---------- Actions ---------- */

  function useSelected() {
    setStatus('Looking for selected clip\u2026');
    callHost('getSelectedMedia').then(function (r) {
      setSource(r.path);
      setStatus('Ready.');
    }).catch(function (e) { setStatus(e.message, 'err'); });
  }

  function browse() {
    var r = window.cep.fs.showOpenDialogEx(false, false, 'Select audio or video file', '',
      ['mp4', 'mov', 'mxf', 'mkv', 'avi', 'wav', 'mp3', 'aif', 'aiff', 'm4a', 'flac']);
    if (r && r.data && r.data.length) { setSource(r.data[0]); setStatus('Ready.'); }
  }

  function run() {
    if (!state.src) return;
    VSLicense.check().then(function (st) {
      if (st.state !== 'valid') {
        setStatus('License problem. Please activate again.', 'err');
        showLicense(st.message || '', st.message ? 'err' : '');
        return;
      }
      doRun();
    });
  }

  function doRun() {
    var strength = parseInt($('strength').value, 10);
    var name = path.basename(state.src, path.extname(state.src));
    var outDir = path.join(path.dirname(state.src), 'VoiceIsolator_' + name);

    state.cancelled = false;
    setBusy(true);
    setProgress(2);
    setStatus('Starting\u2026');

    var enhance = $('enhanceLevel').value;
    runEngine(state.src, outDir, strength, enhance, readEnhParams(), function (m) {
      setProgress(m.percent);
      setStatus(STAGE_LABEL[m.stage] || m.stage);
    }).then(function (files) {
      var note = (files.__warnings && files.__warnings.length) ? ' Note: ' + files.__warnings.join(' ') : '';

      // Kaun si voice "main" hai (original naam wali): enhanced > clean > original
      var voices = [];
      if ($('optEnh').checked && files.voice_enhanced) voices.push({ path: files.voice_enhanced, suffix: '' });
      if ($('optClean').checked) voices.push({ path: files.voice_clean, suffix: ' (clean)' });
      if ($('optOrig').checked) voices.push({ path: files.voice_original, suffix: ' (original)' });
      var items = [];
      voices.forEach(function (v, i) {
        items.push({ path: v.path, kind: 'voice', name: name + (i === 0 ? '' : v.suffix) });
      });
      if ($('optMusic').checked && files.music) items.push({ path: files.music, kind: 'music', name: 'Music' });
      if ($('optNoise').checked && files.noise) items.push({ path: files.noise, kind: 'noise', name: 'Noise' });

      if (!items.length) {
        setProgress(100);
        setStatus('Done. Files saved in: ' + outDir + note, 'ok');
        return;
      }
      setStatus('Importing into project\u2026');
      return callHost('importAndPlace', {
        items: items,
        bin: 'Voice Isolator',
        src: state.src,
        timeline: $('optTimeline').checked,
        muteOriginal: $('optMuteOrig').checked
      }).then(function (r) {
        setProgress(100);
        var msg = 'Done. Imported ' + items.length + ' file(s)';
        if ($('optTimeline').checked) msg += (r.placed ? ', ' + r.placed + ' added to timeline' : ', none added to timeline');
        msg += '. Saved in: ' + outDir + note;
        if (r.note) msg += ' ' + r.note;
        setStatus(msg, 'ok');
      });
    }).catch(function (e) {
      setProgress(0);
      setStatus(e.message === 'Cancelled' ? 'Cancelled.' : e.message, e.message === 'Cancelled' ? '' : 'err');
    }).then(function () { setBusy(false); });
  }

  function cancel() {
    if (!state.proc) return;
    state.cancelled = true;
    try { state.proc.kill(); } catch (e) { /* ignore */ }
  }


  /* ---------- Voice enhance controls ---------- */

  var ENH_PRESETS = {
    studio:  { lowcut: 80, mud: 2, presence: 2.5, air: 1.5, deess: 40, comp: 40, lufs: -16 },
    natural: { lowcut: 70, mud: 0, presence: 0,   air: 0,   deess: 0,  comp: 20, lufs: -16 }
  };
  var ENH_KEYS = ['lowcut', 'mud', 'presence', 'air', 'deess', 'comp', 'lufs'];
  var ENH_UNIT = { lowcut: ' Hz', mud: ' dB', presence: ' dB', air: ' dB', deess: '%', comp: '%', lufs: ' LUFS' };
  var STORE_KEY = 'voiceIsolator.enhance.v1';
  var applyingPreset = false;

  function fmtEnh(k, v) {
    v = parseFloat(v);
    if (v === 0 && k !== 'lufs') return 'off';
    return ((k === 'mud' || k === 'presence' || k === 'air') ? v.toFixed(1) : String(v)) + ENH_UNIT[k];
  }

  function readEnhParams() {
    var o = {};
    ENH_KEYS.forEach(function (k) { o[k] = parseFloat($('p_' + k).value); });
    return o;
  }

  function setEnhParams(p) {
    ENH_KEYS.forEach(function (k) {
      $('p_' + k).value = p[k];
      $('v_' + k).textContent = fmtEnh(k, p[k]);
    });
  }

  function saveEnh() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ level: $('enhanceLevel').value, params: readEnhParams() }));
    } catch (e) { /* ignore */ }
  }

  function syncEnhOptions() {
    var off = ($('enhanceLevel').value === 'off');
    $('optEnh').disabled = off;
    $('advBox').style.opacity = off ? '.45' : '1';
    $('advBox').style.pointerEvents = off ? 'none' : '';
    if (off) { $('optEnh').checked = false; $('optClean').checked = true; }
    else { $('optEnh').checked = true; $('optClean').checked = false; }
  }

  function loadEnh() {
    setEnhParams(ENH_PRESETS.studio);
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (saved && saved.params) {
        if (['studio', 'natural', 'custom', 'off'].indexOf(saved.level) >= 0) $('enhanceLevel').value = saved.level;
        var p = {};
        ENH_KEYS.forEach(function (k) { p[k] = (typeof saved.params[k] === 'number') ? saved.params[k] : ENH_PRESETS.studio[k]; });
        setEnhParams(p);
      }
    } catch (e) { /* ignore */ }
    syncEnhOptions();
  }

  ENH_KEYS.forEach(function (k) {
    $('p_' + k).addEventListener('input', function () {
      $('v_' + k).textContent = fmtEnh(k, this.value);
      if (!applyingPreset && $('enhanceLevel').value !== 'custom') $('enhanceLevel').value = 'custom';
      saveEnh();
    });
  });

  $('btnEnhReset').addEventListener('click', function () {
    $('enhanceLevel').value = 'studio';
    applyingPreset = true; setEnhParams(ENH_PRESETS.studio); applyingPreset = false;
    saveEnh();
  });

  /* ---------- license ---------- */

  function afterLicense() {
    if (isInstalled()) enterMain(); else initSetup(false);
  }

  function showLicense(msg, cls) {
    showView('license');
    $('licStatus').textContent = msg || '\u00a0';
    $('licStatus').className = 'status' + (cls ? ' ' + cls : '');
    $('lnkBuy').style.display = VSLicense.buyUrl() ? '' : 'none';
    $('btnActivate').disabled = false;
  }

  function doActivate() {
    var key = $('licKey').value;
    $('btnActivate').disabled = true;
    $('licStatus').textContent = 'Checking\u2026';
    $('licStatus').className = 'status';
    VSLicense.activate(key).then(function () {
      $('licKey').value = '';
      $('btnActivate').disabled = false;
      afterLicense();
    }).catch(function (e) {
      $('btnActivate').disabled = false;
      $('licStatus').textContent = e.message;
      $('licStatus').className = 'status err';
    });
  }

  function refreshLicenseInfo() {
    VSLicense.check().then(function (st) {
      if (st.disabled || st.state !== 'valid') {
        $('licInfo').textContent = '';
        $('lnkDeactivate').style.display = 'none';
        return;
      }
      $('licInfo').textContent = 'License: ' + st.hint;
      $('lnkDeactivate').style.display = '';
    });
  }

  function doDeactivate() {
    if (!window.confirm('Deactivate this computer? You can then use your key on another computer.')) return;
    VSLicense.deactivate().then(function () {
      showLicense('This computer was deactivated.', '');
    }).catch(function (e) { setStatus(e.message, 'err'); });
  }

  function boot() {
    VSLicense.ensure().then(function (st) {
      if (st.state === 'valid') { afterLicense(); return; }
      if (st.state === 'expired') {
        showLicense(st.message || 'Your license must be verified online. Connect to the internet and enter your key again.', 'err');
        return;
      }
      showLicense(st.message || '', st.message ? 'err' : '');
    }).catch(function (e) { showLicense(e.message, 'err'); });
  }

  /* ---------- Wire up ---------- */

  $('strength').addEventListener('input', function () { $('strengthVal').textContent = this.value + '%'; });
  $('enhanceLevel').addEventListener('change', function () {
    var v = this.value;
    if (ENH_PRESETS[v]) { applyingPreset = true; setEnhParams(ENH_PRESETS[v]); applyingPreset = false; }
    syncEnhOptions();
    saveEnh();
  });
  $('btnSelected').addEventListener('click', useSelected);
  $('btnBrowse').addEventListener('click', browse);
  $('btnRun').addEventListener('click', run);
  $('btnCancel').addEventListener('click', cancel);

  $('btnInstall').addEventListener('click', function () { startInstall(null); });
  $('btnInstallCancel').addEventListener('click', cancelInstall);
  $('packSelect').addEventListener('change', function () { loadPackInfo(this.value); });
  $('lnkLocal').addEventListener('click', function (e) { e.preventDefault(); installFromFile(); });
  $('lnkBack').addEventListener('click', function (e) { e.preventDefault(); enterMain(); });
  $('lnkReinstall').addEventListener('click', function (e) { e.preventDefault(); initSetup(true); });
  $('btnUpdate').addEventListener('click', function (e) {
    e.preventDefault();
    showView('setup');
    $('lnkBack').style.display = '';
    $('detectInfo').textContent = 'Update';
    $('detectWarn').textContent = '';
    $('packSelect').innerHTML = '';
    var o = document.createElement('option');
    o.value = state.packInfo.id; o.textContent = state.packInfo.id;
    $('packSelect').appendChild(o);
    $('packSelect').disabled = true;
    $('dlSize').textContent = 'Download size: ' + VSInstaller.fmtBytes(state.packInfo.size) + '  \u2022  version ' + state.packInfo.version;
    $('btnInstall').disabled = false;
    setSetupStatus('');
  });

  $('btnActivate').addEventListener('click', doActivate);
  $('licKey').addEventListener('keydown', function (e) { if (e.keyCode === 13) doActivate(); });
  $('lnkBuy').addEventListener('click', function (e) { e.preventDefault(); cs.openURLInDefaultBrowser(VSLicense.buyUrl()); });
  $('lnkDeactivate').addEventListener('click', function (e) { e.preventDefault(); doDeactivate(); });

  window.addEventListener('unload', function () { cancel(); cancelInstall(); });

  loadEnh();
  boot();
})();
