/**
 * Web Audio 黑胶练功房引擎（v3 温暖耐听 Lo-Fi 采样版）
 * - 精准鼓机伴奏（Boom Bap / Trap 808 / 纯节拍器）
 * - 4 套真正耐听的音乐向黑胶采样（Lo-Fi 电钢和弦 / Hip-Hop 808 贝斯 / 黑胶长笛切片 / 极简清脆颗粒）
 * - 总线温暖动态压缩 + 正放/倒放双缓冲，彻底告别刺耳电子蜂鸣
 * - 支持导入用户自己的 .wav/.mp3 采样（自动生成倒放缓冲）及一键静音（Serato / djay 伴随模式）
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.beatGain = null;
    this.scratchGain = null;
    this.scratchFilter = null;

    this.beatStyle = 'boombap'; // 'boombap' | 'trap' | 'metro' | 'off'
    this.soundPreset = 'rhodes'; // 'rhodes' | 'bass' | 'flute' | 'perc' | 'mute'
    this.companionMuted = false;

    // 内置预渲染采样库：{ [preset]: { fwd: AudioBuffer, rev: AudioBuffer } }
    this.presetBuffers = {};

    // 自定义导入音频采样
    this.customBuffer = null;
    this.customRevBuffer = null;
    this.customSampleName = null;

    // 当前正在播放的搓盘音源节点
    this.activeSource = null;
    this.activeDir = 0; // 1 = 正放, -1 = 倒放, 0 = 停止
    this._cutStep = 0;

    // 记录上一次调度过的 16 分音符序号
    this._lastStepIndex = -1;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      // 柔和总线压缩器，让鼓点与搓盘采样融为一体、绝不刺耳炸音
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 3.5;
      this.compressor.attack.value = 0.005;
      this.compressor.release.value = 0.14;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.companionMuted ? 0 : 0.9;

      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this.beatGain = this.ctx.createGain();
      this.beatGain.gain.value = 0.72;
      this.beatGain.connect(this.compressor);

      // 搓盘总线：温暖模拟低通 + 平滑门控
      this.scratchFilter = this.ctx.createBiquadFilter();
      this.scratchFilter.type = 'lowpass';
      this.scratchFilter.frequency.value = 3800;
      this.scratchFilter.Q.value = 0.65;

      this.scratchGain = this.ctx.createGain();
      this.scratchGain.gain.value = 0;

      this.scratchFilter.connect(this.scratchGain);
      this.scratchGain.connect(this.compressor);

      this.buildPresetBuffers();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  buildPresetBuffers() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;

    const rhodes = this._renderRhodesChord(sr);
    const bass = this._renderWarmBass(sr);
    const flute = this._renderVinylFlute(sr);
    const perc = this._renderVinylPerc(sr);

    this.presetBuffers = {
      rhodes: { fwd: rhodes, rev: this._createReversedBuffer(rhodes) },
      bass: { fwd: bass, rev: this._createReversedBuffer(bass) },
      flute: { fwd: flute, rev: this._createReversedBuffer(flute) },
      perc: { fwd: perc, rev: this._createReversedBuffer(perc) }
    };
  }

  /**
   * 1. 温暖 Lo-Fi Rhodes 电钢小九和弦（Dm9：D3, F3, A3, C4, E4）
   *    像 J Dilla / Nujabes 黑胶切片一样温柔耐听，切起来极具律动感
   */
  _renderRhodesChord(sr) {
    const dur = 1.6;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    const notes = [146.83, 174.61, 220.0, 261.63, 329.63];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 柔和的 Rhodes 立体颤音（Tremolo）
      const trem = 0.88 + 0.12 * Math.sin(2 * Math.PI * 3.8 * t);
      let sum = 0;
      for (let n = 0; n < notes.length; n++) {
        const f = notes[n];
        // 轻微模拟黑胶转速漂移（Wow）
        const wow = 1 + 0.0022 * Math.sin(2 * Math.PI * 1.1 * t + n);
        const w = 2 * Math.PI * f * wow * t;
        // 电钢核心：纯净基频 + 快速衰减的铃声泛音（Tine）
        const tine = Math.sin(w * 2) * 0.24 * Math.exp(-t * 5.5) + Math.sin(w * 3) * 0.08 * Math.exp(-t * 9);
        const body = Math.sin(w) * (0.65 + 0.35 * Math.exp(-t * 1.4));
        sum += body + tine;
      }
      sum /= notes.length;

      // 极轻的黑胶底噪温暖空气感
      const vinylAir = (Math.random() * 2 - 1) * 0.008;
      const attack = Math.min(1, t / 0.014);
      const release = t > dur - 0.18 ? Math.max(0, (dur - t) / 0.18) : 1;
      data[i] = Math.tanh((sum * trem + vinylAir) * 1.35) * 0.68 * attack * release;
    }
    return buf;
  }

  /**
   * 2. 厚实 Hip-Hop 808 / Analog Sub Bass（F1 温暖低音滑音）
   *    切 Transform / Crab 就像在切低音贝斯线，沉稳带劲不吵耳朵
   */
  _renderWarmBass(sr) {
    const dur = 1.1;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 经典 808 开头微滑落（105Hz -> 73.4Hz D2）
      const freq = 73.42 + 32 * Math.exp(-t * 22);
      phase += freq / sr;
      if (phase >= 1) phase -= 1;

      const sub = Math.sin(2 * Math.PI * phase) * 0.78;
      const warm2 = Math.sin(4 * Math.PI * phase) * 0.32 * (0.4 + 0.6 * Math.exp(-t * 3.5));
      const warm3 = Math.sin(6 * Math.PI * phase) * 0.14 * Math.exp(-t * 5.0);

      const attack = Math.min(1, t / 0.01);
      const decay = 0.62 + 0.38 * Math.exp(-t * 2.2);
      const release = t > dur - 0.12 ? Math.max(0, (dur - t) / 0.12) : 1;
      data[i] = Math.tanh((sub + warm2 + warm3) * 1.4) * 0.72 * attack * decay * release;
    }
    return buf;
  }

  /**
   * 3. 黑胶爵士长笛切片（Vinyl Jazz Flute）
   *    丝滑圆润，搓 Baby Scratch 正反滑音超级好听
   */
  _renderVinylFlute(sr) {
    const dur = 1.3;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    let phase = 0;
    let lpNoise = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const vib = 1 + 0.012 * Math.sin(2 * Math.PI * 5.0 * t) * Math.min(1, t * 3.5);
      const glide = 1 - 0.04 * Math.exp(-t * 16);
      const freq = 440.0 * vib * glide; // A4 爵士音域
      phase += freq / sr;
      if (phase >= 1) phase -= 1;

      const tone =
        Math.sin(2 * Math.PI * phase) * 0.72 +
        Math.sin(4 * Math.PI * phase) * 0.22 +
        Math.sin(6 * Math.PI * phase) * 0.06;

      // 柔和吹奏气声
      const white = Math.random() * 2 - 1;
      lpNoise = lpNoise * 0.82 + white * 0.18;
      const breath = lpNoise * (0.14 * Math.exp(-t * 8) + 0.05);

      const attack = Math.min(1, t / 0.028);
      const release = t > dur - 0.16 ? Math.max(0, (dur - t) / 0.16) : 1;
      data[i] = Math.tanh((tone + breath) * 1.15) * 0.56 * attack * release;
    }
    return buf;
  }

  /**
   * 4. 极简清脆黑胶颗粒切音（Vinyl Rim / Brush Chk）
   *    零旋律干扰，像真实黑胶摩擦的清脆短颗粒，专心练节奏精准度
   */
  _renderVinylPerc(sr) {
    const dur = 0.35;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    let prev = 0;
    let bp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const white = Math.random() * 2 - 1;
      const hp = white - prev * 0.72;
      prev = white;
      bp = bp * 0.6 + hp * 0.4;

      // 轻微木质低频点缀 + 柔和刷子摩擦感
      const knock = Math.sin(2 * Math.PI * 240 * Math.exp(-t * 18) * t) * Math.exp(-t * 32) * 0.45;
      const brush = bp * Math.exp(-t * 11) * 0.7;

      const attack = Math.min(1, t / 0.004);
      data[i] = Math.tanh((knock + brush) * 1.3) * 0.65 * attack;
    }
    return buf;
  }

  _createReversedBuffer(sourceBuf) {
    const rev = this.ctx.createBuffer(
      sourceBuf.numberOfChannels,
      sourceBuf.length,
      sourceBuf.sampleRate
    );
    for (let ch = 0; ch < sourceBuf.numberOfChannels; ch++) {
      const src = sourceBuf.getChannelData(ch);
      const dst = rev.getChannelData(ch);
      for (let i = 0, n = src.length; i < n; i++) {
        dst[i] = src[n - 1 - i];
      }
    }
    return rev;
  }

  getActiveBuffers() {
    if (this.customBuffer) {
      return { fwd: this.customBuffer, rev: this.customRevBuffer || this.customBuffer };
    }
    if (this.soundPreset === 'mute') return null;
    return this.presetBuffers[this.soundPreset] || this.presetBuffers.rhodes || null;
  }

  setSoundPreset(preset) {
    this.soundPreset = preset;
    this.stopActiveSource();
  }

  async loadCustomSample(file) {
    this.ensureContext();
    const arrayBuf = await file.arrayBuffer();
    this.customBuffer = await this.ctx.decodeAudioData(arrayBuf);
    this.customRevBuffer = this._createReversedBuffer(this.customBuffer);
    this.customSampleName = file.name;
    this.stopActiveSource();
    return this.customBuffer.duration;
  }

  clearCustomSample() {
    this.stopActiveSource();
    this.customBuffer = null;
    this.customRevBuffer = null;
    this.customSampleName = null;
  }

  stopCustomSample() {
    this.stopActiveSource();
  }

  stopActiveSource() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch (_) {}
      this.activeSource = null;
      this.activeDir = 0;
    }
  }

  setCompanionMode(muted) {
    this.companionMuted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.015);
    }
    if (muted) {
      this.stopActiveSource();
    }
  }

  setBeatStyle(style) {
    this.beatStyle = style;
  }

  resetBeatClock() {
    this._lastStepIndex = -1;
    this._cutStep = 0;
  }

  /**
   * 横推打开时触发采样（柔和起音 + 乐感微变调，不死板、不刺耳）
   */
  triggerScratchCut(mode) {
    if (!this.ctx || this.companionMuted) return;
    if (mode === 'platter') return;

    const pair = this.getActiveBuffers();
    if (!pair || !pair.fwd) return;

    const now = this.ctx.currentTime;
    this.stopActiveSource();

    const src = this.ctx.createBufferSource();
    src.buffer = pair.fwd;
    src.loop = this.soundPreset !== 'perc';

    // 轻微乐感音高起伏（仅对电钢/贝斯/长笛生效），让连续切音听起来像在玩 MPC / 黑胶切片
    const musicalRates = [1.0, 1.0, 1.0595, 1.0]; // 偶尔微扬半音或保持原调
    const baseRate =
      this.customBuffer || this.soundPreset === 'perc'
        ? 1.0
        : musicalRates[this._cutStep % musicalRates.length];
    this._cutStep += 1;

    src.playbackRate.setValueAtTime(baseRate * 0.96, now);
    src.playbackRate.exponentialRampToValueAtTime(baseRate, now + 0.025);

    src.connect(this.scratchFilter);
    src.start(now, 0);
    this.activeSource = src;
    this.activeDir = 1;
  }

  triggerCustomSampleCut() {
    this.triggerScratchCut('fader');
  }

  /**
   * 16 分音符步进鼓机（温暖 Lo-Fi Hip-Hop 质感）
   */
  updateBeat(currentBeat) {
    if (!this.ctx || this.companionMuted || this.beatStyle === 'off') return;
    if (currentBeat < 0) return;

    const stepIndex = Math.floor(currentBeat * 4);
    if (stepIndex === this._lastStepIndex) return;
    this._lastStepIndex = stepIndex;

    const stepInBar = stepIndex % 16;
    const now = this.ctx.currentTime;

    if (this.beatStyle === 'metro') {
      if (stepInBar % 4 === 0) {
        this.playClick(now, stepInBar === 0 ? 1050 : 720, stepInBar === 0 ? 0.26 : 0.16);
      }
      return;
    }

    if (this.beatStyle === 'boombap') {
      if (stepInBar === 0 || stepInBar === 7 || stepInBar === 10) {
        this.playKick(now, 112, 0.25);
      }
      if (stepInBar === 4 || stepInBar === 12) {
        this.playSnare(now, 0.17);
      }
      if (stepInBar % 2 === 0) {
        this.playHat(now, stepInBar % 4 === 0 ? 0.1 : 0.06);
      }
      return;
    }

    if (this.beatStyle === 'trap') {
      if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10) {
        this.playKick(now, 92, 0.36);
      }
      if (stepInBar === 8) {
        this.playSnare(now, 0.18);
      }
      if (stepInBar % 2 === 0 || stepInBar === 13 || stepInBar === 15) {
        this.playHat(now, 0.075);
      }
    }
  }

  /**
   * 每帧根据实时横推状态 + 转盘速度更新黑胶搓盘声效
   */
  updateScratchSound(mode, faderOpen, platterVel, isPlaying) {
    if (!this.ctx || !this.scratchGain) return;
    const now = this.ctx.currentTime;

    if (this.companionMuted) {
      this.scratchGain.gain.setTargetAtTime(0, now, 0.01);
      return;
    }

    const pair = this.getActiveBuffers();
    if (!pair) {
      this.scratchGain.gain.setTargetAtTime(0, now, 0.01);
      this.stopActiveSource();
      return;
    }

    const speed = Math.abs(platterVel);

    if (mode === 'fader') {
      const targetVol = faderOpen ? 0.68 : 0;
      this.scratchGain.gain.setTargetAtTime(targetVol, now, faderOpen ? 0.008 : 0.018);
      if (faderOpen && !this.activeSource && this.soundPreset !== 'perc') {
        this.triggerScratchCut('fader');
      }
      if (!faderOpen && this.activeSource && this.scratchGain.gain.value < 0.008) {
        this.stopActiveSource();
      }
      return;
    }

    // Platter / Combo / Free 模式：正推正放、反拉倒放，随转盘速度丝滑变调
    const allowSound = mode === 'platter' ? true : faderOpen;
    const isMoving = speed > 0.03;

    if (!allowSound || (!isMoving && !(mode !== 'platter' && faderOpen && isPlaying))) {
      this.scratchGain.gain.setTargetAtTime(0, now, 0.018);
      if (this.activeSource && this.scratchGain.gain.value < 0.008) {
        this.stopActiveSource();
      }
      return;
    }

    const desiredDir = isMoving ? (platterVel >= 0 ? 1 : -1) : 1;
    if (!this.activeSource || this.activeDir !== desiredDir) {
      this.stopActiveSource();
      const src = this.ctx.createBufferSource();
      src.buffer = desiredDir === 1 ? pair.fwd : pair.rev;
      src.loop = true;
      src.connect(this.scratchFilter);
      src.start(now);
      this.activeSource = src;
      this.activeDir = desiredDir;
    }

    const targetVol = isMoving ? Math.min(0.75, 0.24 + speed * 0.45) : 0.36;
    const targetRate = isMoving ? Math.max(0.5, Math.min(2.0, 0.68 + speed * 0.85)) : 1.0;

    this.scratchGain.gain.setTargetAtTime(targetVol, now, 0.014);
    this.activeSource.playbackRate.setTargetAtTime(targetRate, now, 0.022);
    this.scratchFilter.frequency.setTargetAtTime(desiredDir === -1 ? 2600 : 3900, now, 0.025);
  }

  // ---- 合成打击乐器 ----
  playKick(time, startFreq = 112, decay = 0.25) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + decay);

    gain.gain.setValueAtTime(0.85, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay + 0.04);

    osc.connect(gain);
    gain.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + decay + 0.05);
  }

  playSnare(time, decay = 0.17) {
    const bufSize = Math.floor(this.ctx.sampleRate * decay);
    const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.32));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1850;
    filter.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.52, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.beatGain);
    noise.start(time);

    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(185, time);
    osc.frequency.exponentialRampToValueAtTime(102, time + 0.08);
    og.gain.setValueAtTime(0.36, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    osc.connect(og);
    og.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + 0.11);
  }

  playHat(time, vol = 0.08) {
    const bufSize = Math.floor(this.ctx.sampleRate * 0.042);
    const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.24));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.042);

    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.beatGain);
    src.start(time);
  }

  playClick(time, freq = 880, vol = 0.2) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    osc.connect(gain);
    gain.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + 0.036);
  }
}
