/**
 * Web Audio 黑胶练功房引擎（v2 高质感采样版）
 * - 精准鼓机伴奏（Boom Bap / Trap 808 / 纯节拍器）
 * - 3 套高质感离线合成黑胶搓盘采样（经典 Ahh 人声 / 经典 Fresh 颗粒 / Funk 铜管切音），彻底告别“发电报”蜂鸣
 * - 真正的正放 + 倒放双缓冲搓盘引擎：前推正放、后拉倒放，随转盘速度实时变调
 * - 支持导入用户自己的 .wav/.mp3 采样（自动生成倒放缓冲）及一键静音（Serato / djay 伴随模式）
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.beatGain = null;
    this.scratchGain = null;
    this.scratchFilter = null;

    this.beatStyle = 'boombap'; // 'boombap' | 'trap' | 'metro' | 'off'
    this.soundPreset = 'ahh'; // 'ahh' | 'fresh' | 'horn'
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
    this._faderCutOffset = 0; // Fader 连续切音时轻微推进偏移，更有真实黑胶推进感

    // 记录上一次调度过的 16 分音符序号
    this._lastStepIndex = -1;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.companionMuted ? 0 : 0.88;
      this.masterGain.connect(this.ctx.destination);

      this.beatGain = this.ctx.createGain();
      this.beatGain.gain.value = 0.72;
      this.beatGain.connect(this.masterGain);

      // 搓盘总线：串联柔和低通防刺耳 + 音量门控
      this.scratchFilter = this.ctx.createBiquadFilter();
      this.scratchFilter.type = 'lowpass';
      this.scratchFilter.frequency.value = 4600;
      this.scratchFilter.Q.value = 0.7;

      this.scratchGain = this.ctx.createGain();
      this.scratchGain.gain.value = 0;

      this.scratchFilter.connect(this.scratchGain);
      this.scratchGain.connect(this.masterGain);

      // 预渲染 3 套高质感黑胶采样缓冲
      this.buildPresetBuffers();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * 离线预渲染 3 套高质量黑胶搓盘采样（每套含正放 + 倒放双缓冲）
   */
  buildPresetBuffers() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;

    const ahh = this._renderAhhSample(sr);
    const fresh = this._renderFreshSample(sr);
    const horn = this._renderHornSample(sr);

    this.presetBuffers = {
      ahh: { fwd: ahh, rev: this._createReversedBuffer(ahh) },
      fresh: { fwd: fresh, rev: this._createReversedBuffer(fresh) },
      horn: { fwd: horn, rev: this._createReversedBuffer(horn) }
    };
  }

  /**
   * 1. 经典黑胶 "Ahhh" 人声采样（三共振峰 + 声带多谐波 + 气声呼吸感 + 温暖磁带饱和）
   */
  _renderAhhSample(sr) {
    const dur = 1.15;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    // 二阶带通共振峰滤波器状态（3 个元音共振峰 F1=740, F2=1150, F3=2450）
    const makeBpf = (fc, q) => {
      const w0 = (2 * Math.PI * fc) / sr;
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      return {
        b0: alpha / a0,
        b2: -alpha / a0,
        a1: (-2 * Math.cos(w0)) / a0,
        a2: (1 - alpha) / a0,
        x1: 0, x2: 0, y1: 0, y2: 0
      };
    };
    const stepBpf = (f, x) => {
      const y = f.b0 * x + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1; f.x1 = x;
      f.y2 = f.y1; f.y1 = y;
      return y;
    };

    const f1 = makeBpf(740, 5.2);
    const f2 = makeBpf(1150, 6.8);
    const f3 = makeBpf(2450, 8.0);

    let phase = 0;
    let lastNoise = 0;

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 自然男声 Hip-Hop "Ahhh" 语调：开头微扬、中段稳定带颤音、尾音自然微落
      const pitchEnv = 1.0 + 0.045 * Math.exp(-t * 14) - 0.055 * (t / dur);
      const vibrato = 1.0 + 0.009 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t * 4);
      const freq = 148 * pitchEnv * vibrato;
      phase += freq / sr;
      if (phase >= 1) phase -= 1;

      // 温暖的声带脉冲波（比纯锯齿波柔和圆润，不刺耳）
      const glottal =
        Math.sin(2 * Math.PI * phase) * 0.55 +
        Math.sin(4 * Math.PI * phase) * 0.36 +
        Math.sin(6 * Math.PI * phase) * 0.24 +
        Math.sin(8 * Math.PI * phase) * 0.16 +
        Math.sin(10 * Math.PI * phase) * 0.10 +
        Math.sin(12 * Math.PI * phase) * 0.06;

      // 轻微气声与黑胶温暖底噪
      const white = Math.random() * 2 - 1;
      const breath = (white - lastNoise * 0.6) * (0.09 + 0.12 * Math.exp(-t * 18));
      lastNoise = white;

      const exc = glottal + breath;
      const formantMix =
        stepBpf(f1, exc) * 1.45 +
        stepBpf(f2, exc) * 0.95 +
        stepBpf(f3, exc) * 0.42 +
        glottal * 0.14;

      // 顺滑起音与尾音包络
      const attack = Math.min(1, t / 0.022);
      const release = t > dur - 0.12 ? Math.max(0, (dur - t) / 0.12) : 1;
      const vinylSustain = 0.86 + 0.14 * Math.exp(-t * 3.0);

      // 模拟黑胶磁带温暖软饱和
      data[i] = Math.tanh(formantMix * 1.45) * 0.62 * attack * release * vinylSustain;
    }

    return buf;
  }

  /**
   * 2. 经典 "Fresh!" 颗粒感搓盘采样（清脆辅音嘶声起音 + 紧致元音体，最适合 Wicka-Wicka）
   */
  _renderFreshSample(sr) {
    const dur = 0.72;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    let phase = 0;
    let hpPrev = 0;
    let lpPrev = 0;

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const white = Math.random() * 2 - 1;
      const hp = white - hpPrev * 0.75;
      hpPrev = white;

      // 前 90ms 清脆 "Fff-r" 辅音气音 + 尾段 "shh"
      const fricative = Math.exp(-Math.pow((t - 0.035) / 0.042, 2)) * 0.95;
      const tailSh = Math.exp(-Math.pow((t - 0.44) / 0.11, 2)) * 0.55;

      // 中段紧凑 "eh" 声带体
      const vowelEnv = Math.exp(-Math.pow((t - 0.2) / 0.14, 2));
      const freq = 172 * (1.06 - 0.12 * (t / dur));
      phase += freq / sr;
      if (phase >= 1) phase -= 1;

      const body =
        (Math.sin(2 * Math.PI * phase) * 0.5 +
          Math.sin(4 * Math.PI * phase) * 0.35 +
          Math.sin(6 * Math.PI * phase) * 0.25 +
          Math.sin(10 * Math.PI * phase) * 0.15) *
        vowelEnv;

      const raw = hp * (fricative + tailSh) * 0.55 + body * 0.75;
      lpPrev = lpPrev * 0.35 + raw * 0.65;

      const attack = Math.min(1, t / 0.008);
      const release = t > dur - 0.06 ? Math.max(0, (dur - t) / 0.06) : 1;
      data[i] = Math.tanh(lpPrev * 1.6) * 0.62 * attack * release;
    }

    return buf;
  }

  /**
   * 3. Hip-Hop Funk Horn Stab（温暖放克铜管切音，练 Transform / Crab 极其带感）
   */
  _renderHornSample(sr) {
    const dur = 0.85;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    // Fm7 放克铜管三声部（F3, Ab3, C4, Eb4）
    const freqs = [174.61, 207.65, 261.63, 311.13];
    const phases = [0, 0, 0, 0];
    let lp = 0;

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 铜管经典起音微弯音（pitch scoop）
      const scoop = 1.0 - 0.035 * Math.exp(-t * 32);
      let sum = 0;
      for (let v = 0; v < freqs.length; v++) {
        phases[v] += (freqs[v] * scoop) / sr;
        if (phases[v] >= 1) phases[v] -= 1;
        const p = phases[v];
        // 温暖铜管谐波
        sum +=
          Math.sin(2 * Math.PI * p) * 0.48 +
          Math.sin(4 * Math.PI * p) * 0.32 +
          Math.sin(6 * Math.PI * p) * 0.18 +
          Math.sin(8 * Math.PI * p) * 0.08;
      }
      sum /= freqs.length;

      // 铜管动态亮度：开头亮、随后柔和温暖
      const bright = 0.35 + 0.45 * Math.exp(-t * 6.5);
      lp = lp * (1 - bright) + sum * bright;

      const attack = Math.min(1, t / 0.014);
      const decay = 0.72 + 0.28 * Math.exp(-t * 4.5);
      const release = t > dur - 0.1 ? Math.max(0, (dur - t) / 0.1) : 1;
      data[i] = Math.tanh(lp * 2.1) * 0.58 * attack * decay * release;
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
    return this.presetBuffers[this.soundPreset] || this.presetBuffers.ahh || null;
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
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.88, this.ctx.currentTime, 0.015);
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
    this._faderCutOffset = 0;
  }

  /**
   * 横推打开（上升沿）时触发黑胶切音采样（带柔和起转音高，彻底告别“发电报”蜂鸣）
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
    src.loop = true;

    // 模拟真实黑胶被推开瞬间的微加速质感（0.93 -> 1.0），听感极其自然
    src.playbackRate.setValueAtTime(0.93, now);
    src.playbackRate.exponentialRampToValueAtTime(1.0, now + 0.032);

    src.connect(this.scratchFilter);

    // 连续快切时让起音有极轻微的律动起伏，不死板机械
    const startOffset =
      this.customBuffer || this.soundPreset === 'fresh'
        ? 0
        : (this._faderCutOffset % 3) * 0.018;
    this._faderCutOffset += 1;

    src.start(now, Math.min(startOffset, Math.max(0, pair.fwd.duration - 0.05)));
    this.activeSource = src;
    this.activeDir = 1;
  }

  /**
   * 兼容旧调用名称
   */
  triggerCustomSampleCut() {
    this.triggerScratchCut('fader');
  }

  /**
   * 由主循环驱动的 16 分音符步进鼓机（与画布节奏拍点严格同步）
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
        this.playClick(now, stepInBar === 0 ? 1150 : 780, stepInBar === 0 ? 0.3 : 0.18);
      }
      return;
    }

    if (this.beatStyle === 'boombap') {
      if (stepInBar === 0 || stepInBar === 7 || stepInBar === 10) {
        this.playKick(now, 118, 0.24);
      }
      if (stepInBar === 4 || stepInBar === 12) {
        this.playSnare(now, 0.17);
      }
      if (stepInBar % 2 === 0) {
        this.playHat(now, stepInBar % 4 === 0 ? 0.12 : 0.075);
      }
      return;
    }

    if (this.beatStyle === 'trap') {
      if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10) {
        this.playKick(now, 96, 0.36);
      }
      if (stepInBar === 8) {
        this.playSnare(now, 0.19);
      }
      if (stepInBar % 2 === 0 || stepInBar === 13 || stepInBar === 15) {
        this.playHat(now, 0.085);
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
    if (!pair) return;

    const speed = Math.abs(platterVel);

    if (mode === 'fader') {
      // Fader 专项模式：由横推开合柔和门控（10ms 平滑淡入淡出，无咔嗒电报感）
      const targetVol = faderOpen ? 0.72 : 0;
      this.scratchGain.gain.setTargetAtTime(targetVol, now, faderOpen ? 0.006 : 0.011);
      if (faderOpen && !this.activeSource) {
        this.triggerScratchCut('fader');
      }
      if (!faderOpen && this.activeSource && this.scratchGain.gain.value < 0.008) {
        this.stopActiveSource();
      }
      return;
    }

    // Platter / Combo / Free 模式：根据转盘方向与速度进行真·正反搓盘播放
    const allowSound = mode === 'platter' ? true : faderOpen;
    const isMoving = speed > 0.035;

    if (!allowSound || (!isMoving && !(mode !== 'platter' && faderOpen && isPlaying))) {
      this.scratchGain.gain.setTargetAtTime(0, now, 0.014);
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

    const targetVol = isMoving ? Math.min(0.78, 0.25 + speed * 0.45) : 0.38;
    const targetRate = isMoving ? Math.max(0.45, Math.min(2.15, 0.62 + speed * 0.95)) : 1.0;

    this.scratchGain.gain.setTargetAtTime(targetVol, now, 0.012);
    this.activeSource.playbackRate.setTargetAtTime(targetRate, now, 0.018);

    // 倒拉时滤波略微变暖，还原真实黑胶倒放听感
    const targetCutoff = desiredDir === -1 ? 3200 : 4800;
    this.scratchFilter.frequency.setTargetAtTime(targetCutoff, now, 0.02);
  }

  // ---- 合成打击乐器 ----
  playKick(time, startFreq = 118, decay = 0.24) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + decay);

    gain.gain.setValueAtTime(0.88, time);
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
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.34));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1150;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.55, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.beatGain);
    noise.start(time);

    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(192, time);
    osc.frequency.exponentialRampToValueAtTime(108, time + 0.08);
    og.gain.setValueAtTime(0.38, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    osc.connect(og);
    og.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + 0.11);
  }

  playHat(time, vol = 0.1) {
    const bufSize = Math.floor(this.ctx.sampleRate * 0.045);
    const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.25));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6800;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.045);

    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.beatGain);
    src.start(time);
  }

  playClick(time, freq = 900, vol = 0.22) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.032);
    osc.connect(gain);
    gain.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + 0.04);
  }
}
