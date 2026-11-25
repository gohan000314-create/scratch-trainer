import { PATTERNS } from './patterns.js';
import { MidiEngine } from './midi.js';
import { AudioEngine } from './audio.js';
import { StageRenderer } from './renderer.js';

// ---- DOM 元素索引 ----
const el = {
  canvas: document.getElementById('stageCanvas'),
  midiStatusDot: document.getElementById('midiStatusDot'),
  midiDeviceLabel: document.getElementById('midiDeviceLabel'),
  modeTag: document.getElementById('modeTag'),
  patternTitle: document.getElementById('patternTitle'),
  bpmDisplay: document.getElementById('bpmDisplay'),
  modeSubtitle: document.getElementById('modeSubtitle'),

  hudStats: document.getElementById('hudStats'),
  statAccuracyLabel: document.getElementById('statAccuracyLabel'),
  statAccuracy: document.getElementById('statAccuracy'),
  statComboItem: document.getElementById('statComboItem'),
  statCombo: document.getElementById('statCombo'),
  statHitsItem: document.getElementById('statHitsItem'),
  statHitsLabel: document.getElementById('statHitsLabel'),
  statHits: document.getElementById('statHits'),

  faderStateText: document.getElementById('faderStateText'),
  faderMeterFill: document.getElementById('faderMeterFill'),
  faderCutLine: document.getElementById('faderCutLine'),
  platterVelText: document.getElementById('platterVelText'),
  platterMeterFill: document.getElementById('platterMeterFill'),
  judgePopup: document.getElementById('judgePopup'),

  modeSelector: document.getElementById('modeSelector'),
  patternSelect: document.getElementById('patternSelect'),
  btnPlayPause: document.getElementById('btnPlayPause'),
  btnResetStats: document.getElementById('btnResetStats'),
  bpmSlider: document.getElementById('bpmSlider'),
  bpmNum: document.getElementById('bpmNum'),
  btnBpmDown: document.getElementById('btnBpmDown'),
  btnBpmUp: document.getElementById('btnBpmUp'),
  beatSelect: document.getElementById('beatSelect'),
  soundPresetSelect: document.getElementById('soundPresetSelect'),
  sampleFileInput: document.getElementById('sampleFileInput'),
  btnClearSample: document.getElementById('btnClearSample'),
  btnCompanionMode: document.getElementById('btnCompanionMode'),
  companionState: document.getElementById('companionState'),

  midiDrawer: document.getElementById('midiDrawer'),
  btnOpenMidi: document.getElementById('btnOpenMidi'),
  btnCloseMidi: document.getElementById('btnCloseMidi'),
  midiInputSelect: document.getElementById('midiInputSelect'),
  btnRefreshMidi: document.getElementById('btnRefreshMidi'),
  midiSupportNote: document.getElementById('midiSupportNote'),
  btnLearnFader: document.getElementById('btnLearnFader'),
  btnLearnPlatter: document.getElementById('btnLearnPlatter'),
  faderMappingInfo: document.getElementById('faderMappingInfo'),
  platterMappingInfo: document.getElementById('platterMappingInfo'),
  chkHamster: document.getElementById('chkHamster'),
  cutInSlider: document.getElementById('cutInSlider'),
  cutInVal: document.getElementById('cutInVal'),
  faderSideSelect: document.getElementById('faderSideSelect'),
  platterModeSelect: document.getElementById('platterModeSelect'),
  platterSensSlider: document.getElementById('platterSensSlider'),
  platterSensVal: document.getElementById('platterSensVal'),
  chkPlatterInvert: document.getElementById('chkPlatterInvert'),
  scrollSpeedSlider: document.getElementById('scrollSpeedSlider'),
  scrollSpeedVal: document.getElementById('scrollSpeedVal'),
  judgeWindowSlider: document.getElementById('judgeWindowSlider'),
  judgeWindowVal: document.getElementById('judgeWindowVal'),
  btnResetMapping: document.getElementById('btnResetMapping'),
  midiLog: document.getElementById('midiLog'),
  btnClearLog: document.getElementById('btnClearLog')
};

// ---- 应用核心状态 ----
const state = {
  mode: 'fader', // 'fader' | 'platter' | 'combo' | 'free'
  pattern: PATTERNS.fader[0],
  bpm: PATTERNS.fader[0].defaultBpm,
  isPlaying: false,
  currentBeat: -1.5, // 启动前留出 1.5 拍预备滚入缓冲
  lastFrameTime: performance.now(),
  companionMode: false
};

let judgeTimer = null;
const logLines = [];

// ---- 初始化三大引擎 ----
const audio = new AudioEngine();

const renderer = new StageRenderer(el.canvas, {
  onStatsChanged(stats) {
    el.statAccuracy.textContent = `${stats.accuracy}%`;
    el.statCombo.textContent = `${stats.combo}`;
    el.statHits.textContent = `${stats.hits} / ${stats.total}`;
  },
  onJudge(label, cls, diffMs) {
    const msText = cls === 'miss' ? '' : ` (${diffMs >= 0 ? '+' : ''}${diffMs}ms)`;
    el.judgePopup.textContent = `${label}${msText}`;
    el.judgePopup.className = `judge-popup show ${cls}`;
    if (judgeTimer) clearTimeout(judgeTimer);
    judgeTimer = setTimeout(() => {
      el.judgePopup.classList.remove('show');
    }, 360);
  }
});

const midi = new MidiEngine({
  onSupportError(msg) {
    el.midiSupportNote.textContent = msg;
    el.midiSupportNote.style.color = '#ff7b93';
  },
  onDevicesChanged(inputs, active) {
    el.midiInputSelect.innerHTML = '';
    if (inputs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未检测到 MIDI 控制器（请插上 Rane One 后点刷新）';
      el.midiInputSelect.appendChild(opt);
      el.midiStatusDot.classList.remove('connected');
      el.midiDeviceLabel.textContent = '未连接 MIDI（可用键盘/鼠标体验）';
      return;
    }

    for (const inp of inputs) {
      const opt = document.createElement('option');
      opt.value = inp.id;
      opt.textContent = inp.name || `MIDI 设备 (${inp.id})`;
      if (active && inp.id === active.id) opt.selected = true;
      el.midiInputSelect.appendChild(opt);
    }

    if (active) {
      el.midiStatusDot.classList.add('connected');
      el.midiDeviceLabel.textContent = `已连接：${active.name}`;
    }
  },
  onLearnState(target) {
    el.btnLearnFader.classList.toggle('learning', target === 'fader');
    el.btnLearnPlatter.classList.toggle('learning', target === 'platter');
    el.btnLearnFader.textContent =
      target === 'fader' ? '⏳ 请来回推一下横推...' : '🎯 学习横推（动一下横推）';
    el.btnLearnPlatter.textContent =
      target === 'platter' ? '⏳ 请来回搓一下转盘...' : '🎯 学习转盘（来回搓一下）';
  },
  onConfigChanged(cfg) {
    syncConfigToUI(cfg);
  },
  onRawLog(line) {
    const now = new Date();
    const ts = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    logLines.push(`${ts}  ${line}`);
    if (logLines.length > 45) logLines.shift();
    if (el.midiDrawer.classList.contains('open')) {
      el.midiLog.textContent = logLines.join('\n');
      el.midiLog.scrollTop = el.midiLog.scrollHeight;
    }
  },
  onFaderCutOn() {
    if (state.isPlaying) {
      renderer.handleFaderCutTrigger(state.currentBeat, state.bpm, state.mode, state.pattern, 'open');
    }
    audio.ensureContext();
    audio.triggerScratchCut(state.mode);
  },
  onFaderCutOff() {
    if (state.isPlaying) {
      renderer.handleFaderCutTrigger(state.currentBeat, state.bpm, state.mode, state.pattern, 'close');
    }
  }
});

// ---- 同步设置面板 UI ----
function syncConfigToUI(cfg) {
  if (cfg.fader) {
    const detail =
      cfg.fader.type === 'cc'
        ? `已绑定: CH${cfg.fader.channel} CC#${cfg.fader.cc}${cfg.fader.lsbCc !== null ? ` (+LSB#${cfg.fader.lsbCc} 14-bit)` : ''}`
        : `已绑定: CH${cfg.fader.channel} PitchBend`;
    el.faderMappingInfo.textContent = detail;
  } else {
    el.faderMappingInfo.textContent = '未绑定（可用空格 / J / K 模拟）';
  }

  if (cfg.platter) {
    const detail =
      cfg.platter.type === 'cc'
        ? `已绑定: CH${cfg.platter.channel} CC#${cfg.platter.cc}`
        : `已绑定: CH${cfg.platter.channel} PitchBend`;
    el.platterMappingInfo.textContent = detail;
  } else {
    el.platterMappingInfo.textContent = '未绑定（可在画布左右拖动鼠标 / 滚轮模拟）';
  }

  el.chkHamster.checked = cfg.hamster;
  el.cutInSlider.value = Math.round(cfg.cutIn * 100);
  el.cutInVal.textContent = `${Math.round(cfg.cutIn * 100)}%`;
  el.faderCutLine.style.left = `${Math.round(cfg.cutIn * 100)}%`;
  el.faderSideSelect.value = cfg.faderSide;
  el.platterModeSelect.value = cfg.platterMode;
  el.platterSensSlider.value = cfg.platterSens;
  el.platterSensVal.textContent = `${cfg.platterSens.toFixed(2)}x`;
  el.chkPlatterInvert.checked = cfg.platterInvert;

  // 同步视觉与判定参数到 UI 与渲染器
  const scrollSpeed = cfg.scrollSpeed ?? 1.0;
  const judgeWindowMs = cfg.judgeWindowMs ?? 75;
  renderer.scrollSpeed = scrollSpeed;
  renderer.judgeWindowMs = judgeWindowMs;
  el.scrollSpeedSlider.value = scrollSpeed;
  el.scrollSpeedVal.textContent = `${scrollSpeed.toFixed(1)}x`;
  el.judgeWindowSlider.value = judgeWindowMs;
  el.judgeWindowVal.textContent = `±${judgeWindowMs}ms`;
}

// ---- 模式与谱面切换 ----
const MODE_META = {
  fader: { tag: 'FADER', sub: 'Fader', cls: 'mode-fader' },
  platter: { tag: 'RHYTHM', sub: 'Platter', cls: 'mode-platter' },
  combo: { tag: 'COMBO', sub: 'Fader + Platter', cls: 'mode-combo' },
  free: { tag: 'SCOPE', sub: 'Free Visualizer', cls: 'mode-free' }
};

function populatePatterns(mode) {
  const list = PATTERNS[mode] || [];
  el.patternSelect.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    el.patternSelect.appendChild(opt);
  }
  if (list.length > 0) {
    selectPattern(list[0].id);
  }
}

function selectPattern(patternId) {
  const list = PATTERNS[state.mode] || [];
  const found = list.find((p) => p.id === patternId) || list[0];
  if (!found) return;
  state.pattern = found;
  el.patternSelect.value = found.id;
  setBpm(found.defaultBpm);
  updateHeaderPill();
  resetSession();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeSelector .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  updateHudForMode(mode);
  populatePatterns(mode);
  updateHeaderPill();
}

function updateHudForMode(mode) {
  if (mode === 'free') {
    el.hudStats.style.display = 'none';
    return;
  }
  el.hudStats.style.display = 'flex';
  if (mode === 'platter') {
    el.statAccuracyLabel.textContent = '曲线贴合度';
    el.statComboItem.style.display = 'none';
    el.statHitsItem.style.display = 'none';
  } else if (mode === 'combo') {
    el.statAccuracyLabel.textContent = '综合准确率';
    el.statHitsLabel.textContent = '切音命中';
    el.statComboItem.style.display = 'flex';
    el.statHitsItem.style.display = 'flex';
  } else {
    el.statAccuracyLabel.textContent = '准确率';
    el.statHitsLabel.textContent = '命中 / 总计';
    el.statComboItem.style.display = 'flex';
    el.statHitsItem.style.display = 'flex';
  }
}

function setBpm(bpm) {
  const clamped = Math.max(65, Math.min(145, Math.round(bpm)));
  state.bpm = clamped;
  el.bpmSlider.value = clamped;
  el.bpmNum.textContent = clamped;
  el.bpmDisplay.textContent = `${clamped} BPM`;
}

function updateHeaderPill() {
  const meta = MODE_META[state.mode];
  el.modeTag.textContent = meta.tag;
  el.modeTag.className = `pill-tag ${meta.cls}`;
  el.modeSubtitle.textContent = meta.sub;
  el.patternTitle.textContent = state.pattern?.shortTitle || '';
  el.bpmDisplay.textContent = `${state.bpm} BPM`;
}

function togglePlay() {
  audio.ensureContext();
  state.isPlaying = !state.isPlaying;
  el.btnPlayPause.textContent = state.isPlaying ? '⏸ 暂停练习' : '▶ 开始练习';
  el.btnPlayPause.classList.toggle('playing', state.isPlaying);
  if (state.isPlaying) {
    state.lastFrameTime = performance.now();
  }
}

function resetSession() {
  state.currentBeat = -1.5;
  audio.resetBeatClock();
  renderer.reset();
  midi.resetPlatter();
}

// ---- 事件绑定 ----
el.modeSelector.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setMode(btn.dataset.mode);
});

el.patternSelect.addEventListener('change', (e) => {
  selectPattern(e.target.value);
});

el.btnPlayPause.addEventListener('click', togglePlay);
el.btnResetStats.addEventListener('click', resetSession);

el.bpmSlider.addEventListener('input', (e) => setBpm(Number(e.target.value)));
el.btnBpmDown.addEventListener('click', () => setBpm(state.bpm - 1));
el.btnBpmUp.addEventListener('click', () => setBpm(state.bpm + 1));

el.beatSelect.addEventListener('change', (e) => {
  audio.setBeatStyle(e.target.value);
});

el.soundPresetSelect.addEventListener('change', (e) => {
  audio.ensureContext();
  audio.setSoundPreset(e.target.value);
});

el.sampleFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const dur = await audio.loadCustomSample(file);
    el.btnClearSample.style.display = 'inline-flex';
    alert(`已成功导入采样「${file.name}」（时长 ${dur.toFixed(2)} 秒），已自动静音内置合成音色！`);
  } catch (err) {
    alert(`音频解码失败：${err.message}`);
  }
});

el.btnClearSample.addEventListener('click', () => {
  audio.clearCustomSample();
  el.sampleFileInput.value = '';
  el.btnClearSample.style.display = 'none';
});

el.btnCompanionMode.addEventListener('click', () => {
  state.companionMode = !state.companionMode;
  audio.setCompanionMode(state.companionMode);
  el.companionState.textContent = state.companionMode ? '开（已静音）' : '关';
  el.btnCompanionMode.classList.toggle('active-toggle', state.companionMode);
});

// 抽屉开关
el.btnOpenMidi.addEventListener('click', () => {
  el.midiDrawer.classList.add('open');
  el.midiLog.textContent = logLines.length ? logLines.join('\n') : '等待 MIDI 信号...';
});
el.btnCloseMidi.addEventListener('click', () => {
  midi.cancelLearn();
  el.midiDrawer.classList.remove('open');
});

el.btnRefreshMidi.addEventListener('click', () => midi.refreshInputs());
el.midiInputSelect.addEventListener('change', (e) => midi.selectInput(e.target.value));

el.btnLearnFader.addEventListener('click', () => {
  if (midi.learningTarget === 'fader') midi.cancelLearn();
  else midi.startLearn('fader');
});
el.btnLearnPlatter.addEventListener('click', () => {
  if (midi.learningTarget === 'platter') midi.cancelLearn();
  else midi.startLearn('platter');
});

el.chkHamster.addEventListener('change', (e) => {
  midi.config.hamster = e.target.checked;
  midi.saveConfig();
});
el.cutInSlider.addEventListener('input', (e) => {
  const v = Number(e.target.value) / 100;
  midi.config.cutIn = v;
  el.cutInVal.textContent = `${e.target.value}%`;
  el.faderCutLine.style.left = `${e.target.value}%`;
  midi.saveConfig();
});
el.faderSideSelect.addEventListener('change', (e) => {
  midi.config.faderSide = e.target.value;
  midi.saveConfig();
});
el.platterModeSelect.addEventListener('change', (e) => {
  midi.config.platterMode = e.target.value;
  midi.saveConfig();
});
el.platterSensSlider.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  midi.config.platterSens = v;
  el.platterSensVal.textContent = `${v.toFixed(2)}x`;
  midi.saveConfig();
});
el.chkPlatterInvert.addEventListener('change', (e) => {
  midi.config.platterInvert = e.target.checked;
  midi.saveConfig();
});

el.scrollSpeedSlider.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  renderer.scrollSpeed = v;
  midi.config.scrollSpeed = v;
  midi.saveConfig();
  el.scrollSpeedVal.textContent = `${v.toFixed(1)}x`;
});
el.judgeWindowSlider.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  renderer.judgeWindowMs = v;
  midi.config.judgeWindowMs = v;
  midi.saveConfig();
  el.judgeWindowVal.textContent = `±${v}ms`;
});
el.btnResetMapping.addEventListener('click', () => {
  midi.resetConfig();
});
el.btnClearLog.addEventListener('click', () => {
  logLines.length = 0;
  el.midiLog.textContent = '已清空，等待 MIDI 信号...';
});

// ---- 无硬件备用交互（键盘切横推 + 鼠标左右拖/滚轮搓盘） ----
const activeCutKeys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  if (e.code === 'Enter') {
    e.preventDefault();
    togglePlay();
    return;
  }

  if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'KeyK' || e.code === 'KeyF') {
    e.preventDefault();
    if (!activeCutKeys.has(e.code)) {
      activeCutKeys.add(e.code);
      audio.ensureContext();
      midi.setFaderLevel(1.0);
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (activeCutKeys.has(e.code)) {
    activeCutKeys.delete(e.code);
    if (activeCutKeys.size === 0) {
      midi.setFaderLevel(0.0);
    }
  }
});

// 鼠标在画布上左右拖动模拟搓盘
let isDraggingPlatter = false;
let lastMouseX = 0;

el.canvas.addEventListener('pointerdown', (e) => {
  audio.ensureContext();
  isDraggingPlatter = true;
  lastMouseX = e.clientX;
  el.canvas.setPointerCapture(e.pointerId);
});

el.canvas.addEventListener('pointermove', (e) => {
  if (!isDraggingPlatter) return;
  const dx = e.clientX - lastMouseX;
  lastMouseX = e.clientX;
  midi.applyPlatterDelta(dx / 260);
});

el.canvas.addEventListener('pointerup', () => {
  isDraggingPlatter = false;
});

el.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    audio.ensureContext();
    midi.applyPlatterDelta(-e.deltaY / 750);
  },
  { passive: false }
);

window.addEventListener('resize', () => renderer.resize());

// ---- 主渲染循环（60/120fps） ----
function loop(now) {
  const dt = Math.min(0.05, (now - state.lastFrameTime) / 1000);
  state.lastFrameTime = now;

  midi.tickDecay(dt);

  if (state.isPlaying) {
    const beatsPerSec = state.bpm / 60;
    state.currentBeat += dt * beatsPerSec;

    // 驱动内置鼓机
    audio.updateBeat(state.currentBeat);

    // 记录一帧历史用于波形绘制与 Platter 评分
    renderer.recordSample(
      state.currentBeat,
      state.mode,
      state.pattern,
      midi.faderRaw,
      midi.faderOpen,
      midi.platterPos
    );
  }

  // 更新搓盘合成音色
  audio.updateScratchSound(state.mode, midi.faderOpen, midi.platterVel, state.isPlaying);

  // 更新右上角实时仪表
  el.faderMeterFill.style.width = `${Math.round(midi.faderRaw * 100)}%`;
  el.faderStateText.textContent = midi.faderOpen ? '开音 OPEN' : '关音 CUT';
  el.faderStateText.style.color = midi.faderOpen ? '#22e58b' : '#8c95a6';

  const velNorm = Math.max(-1, Math.min(1, midi.platterVel / 1.5));
  el.platterVelText.textContent = `${midi.platterVel >= 0 ? '+' : ''}${midi.platterVel.toFixed(1)}`;
  if (velNorm >= 0) {
    el.platterMeterFill.style.left = '50%';
    el.platterMeterFill.style.width = `${velNorm * 50}%`;
  } else {
    el.platterMeterFill.style.left = `${50 + velNorm * 50}%`;
    el.platterMeterFill.style.width = `${-velNorm * 50}%`;
  }

  // 绘制画布
  renderer.render({
    currentBeat: state.currentBeat,
    bpm: state.bpm,
    mode: state.mode,
    pattern: state.pattern,
    faderRaw: midi.faderRaw,
    faderOpen: midi.faderOpen,
    platterPos: midi.platterPos,
    isPlaying: state.isPlaying
  });

  requestAnimationFrame(loop);
}

// ---- 启动 ----
syncConfigToUI(midi.config);
setMode('fader');
midi.init();
requestAnimationFrame(loop);
