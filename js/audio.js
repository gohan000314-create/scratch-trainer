/**
 * Web Audio 练功房引擎
 * - 精准鼓机伴奏（Boom Bap / Trap 808 / 纯节拍器）
 * - 实时搓盘音频引擎：支持默认合成 "Ahhh" 搓盘音色 + 用户自定义音频采样导入
 * - 支持一键静音（配合 macOS Serato / djay 伴随模式）
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.beatGain = null;
    this.scratchGain = null;

    this.beatStyle = 'boombap'; // 'boombap' | 'trap' | 'metro' | 'off'
    this.companionMuted = false;

    // 合成搓盘音色节点（默认锯齿波 + 共振峰滤波，模拟经典 Ahhh）
    this.synthOsc = null;
    this.synthFilter1 = null;
    this.synthFilter2 = null;
    this.synthSubGain = null;
    this.synthRunning = false;

    // 自定义导入音频采样
    this.customBuffer = null;
    this.customSource = null;
    this.customSampleName = null;

    // 记录上一次调度过的 16 分音符序号
    this._lastStepIndex = -1;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.companionMuted ? 0 : 0.85;
      this.masterGain.connect(this.ctx.destination);

      this.beatGain = this.ctx.createGain();
      this.beatGain.gain.value = 0.72;
      this.beatGain.connect(this.masterGain);

      this.scratchGain = this.ctx.createGain();
      this.scratchGain.gain.value = 0;
      this.scratchGain.connect(this.masterGain);

      this.initScratchSynth();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  initScratchSynth() {
    if (this.synthRunning || !this.ctx) return;

    // 经典 Ahhh 风格共振峰合成器（双滤波并联）
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 185;

    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 780;
    f1.Q.value = 4.2;

    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1280;
    f2.Q.value = 5.0;

    const subGain = this.ctx.createGain();
    subGain.gain.value = this.customBuffer ? 0 : 0.55;

    osc.connect(f1);
    osc.connect(f2);
    f1.connect(subGain);
    f2.connect(subGain);
    subGain.connect(this.scratchGain);

    osc.start();
    this.synthOsc = osc;
    this.synthFilter1 = f1;
    this.synthFilter2 = f2;
    this.synthSubGain = subGain;
    this.synthRunning = true;
  }

  async loadCustomSample(file) {
    this.ensureContext();
    const arrayBuf = await file.arrayBuffer();
    this.customBuffer = await this.ctx.decodeAudioData(arrayBuf);
    this.customSampleName = file.name;
    // 导入自定义采样后静音内置锯齿波合成器，避免叠音
    if (this.synthSubGain && this.ctx) {
      this.synthSubGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    }
    return this.customBuffer.duration;
  }

  clearCustomSample() {
    this.stopCustomSample();
    this.customBuffer = null;
    this.customSampleName = null;
    // 恢复内置锯齿波合成器
    if (this.synthSubGain && this.ctx) {
      this.synthSubGain.gain.setTargetAtTime(0.55, this.ctx.currentTime, 0.01);
    }
  }

  stopCustomSample() {
    if (this.customSource) {
      try {
        this.customSource.stop();
      } catch (_) {}
      this.customSource = null;
    }
  }

  setCompanionMode(muted) {
    this.companionMuted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.015);
    }
  }

  setBeatStyle(style) {
    this.beatStyle = style;
  }

  resetBeatClock() {
    this._lastStepIndex = -1;
  }

  /**
   * 由主循环驱动的 16 分音符步进鼓机（与画布节奏拍点严格同步）
   * @param {number} currentBeat 当前累计拍数
   */
  updateBeat(currentBeat) {
    if (!this.ctx || this.companionMuted || this.beatStyle === 'off') return;
    if (currentBeat < 0) return;

    const stepIndex = Math.floor(currentBeat * 4); // 每拍 4 个 16 分音符
    if (stepIndex === this._lastStepIndex) return;
    this._lastStepIndex = stepIndex;

    const stepInBar = stepIndex % 16;
    const now = this.ctx.currentTime;

    if (this.beatStyle === 'metro') {
      if (stepInBar % 4 === 0) {
        this.playClick(now, stepInBar === 0 ? 1200 : 820, stepInBar === 0 ? 0.35 : 0.22);
      }
      return;
    }

    if (this.beatStyle === 'boombap') {
      // 经典 90s Hip-Hop Boom Bap 鼓型
      if (stepInBar === 0 || stepInBar === 7 || stepInBar === 10) {
        this.playKick(now, 115, 0.22);
      }
      if (stepInBar === 4 || stepInBar === 12) {
        this.playSnare(now, 0.16);
      }
      if (stepInBar % 2 === 0) {
        this.playHat(now, stepInBar % 4 === 0 ? 0.13 : 0.08);
      }
      return;
    }

    if (this.beatStyle === 'trap') {
      // Trap 808 风格（类似视频背景鼓点氛围）
      if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10) {
        this.playKick(now, 95, 0.34);
      }
      if (stepInBar === 8) {
        this.playSnare(now, 0.18);
      }
      if (stepInBar % 2 === 0 || stepInBar === 13 || stepInBar === 15) {
        this.playHat(now, 0.09);
      }
    }
  }

  /**
   * 根据实时横推状态 + 转盘速度更新搓盘声效
   */
  updateScratchSound(mode, faderOpen, platterVel, isPlaying) {
    if (!this.ctx || !this.scratchGain) return;
    const now = this.ctx.currentTime;

    if (this.companionMuted) {
      this.scratchGain.gain.setTargetAtTime(0, now, 0.01);
      return;
    }

    // Fader 专项模式下，只要横推打开就自动持续出声（模拟唱盘匀速转动、手只切横推）
    let activeVol = 0;
    let pitchFactor = 1.0;

    if (mode === 'fader') {
      activeVol = faderOpen ? 0.42 : 0;
      pitchFactor = 1.0;
    } else if (mode === 'platter') {
      // Platter 模式默认横推常开，根据转盘速度动态出声与变调
      const speed = Math.abs(platterVel);
      activeVol = speed > 0.04 ? Math.min(0.48, 0.14 + speed * 0.25) : 0;
      pitchFactor = 0.65 + Math.min(2.2, speed * 0.9);
    } else {
      // Combo / Free 模式：横推必须打开且（转盘在动或在播放中）
      const speed = Math.abs(platterVel);
      if (faderOpen) {
        activeVol = speed > 0.03 ? Math.min(0.48, 0.18 + speed * 0.24) : isPlaying ? 0.22 : 0;
      }
      pitchFactor = speed > 0.03 ? 0.65 + Math.min(2.2, speed * 0.85) : 1.0;
    }

    this.scratchGain.gain.setTargetAtTime(activeVol, now, 0.008);

    // 若加载了自定义采样，在 Platter 模式下随转盘速度触发与实时变调
    if (this.customBuffer) {
      const speed = Math.abs(platterVel);
      if (mode === 'platter') {
        if (speed > 0.05 && !this.customSource) {
          this.triggerCustomSampleCut(true);
        } else if (speed <= 0.03 && this.customSource) {
          this.stopCustomSample();
        }
      }
      if (this.customSource) {
        const rate = Math.max(0.35, Math.min(2.4, pitchFactor));
        this.customSource.playbackRate.setTargetAtTime(rate, now, 0.02);
      }
      return;
    }

    if (this.synthOsc && this.synthFilter1 && this.synthFilter2) {
      const baseFreq = 185 * pitchFactor;
      const dirShift = platterVel < -0.05 ? 0.88 : 1.0; // 反拉时共振峰略微变暗，更有黑胶倒放味
      this.synthOsc.frequency.setTargetAtTime(baseFreq * dirShift, now, 0.015);
      this.synthFilter1.frequency.setTargetAtTime(760 * pitchFactor * dirShift, now, 0.015);
      this.synthFilter2.frequency.setTargetAtTime(1260 * pitchFactor, now, 0.015);
    }
  }

  /**
   * 播放自定义采样（Fader 上升沿触发，或在 Platter 模式下循环触发）
   */
  triggerCustomSampleCut(loop = false) {
    if (!this.ctx || !this.customBuffer || this.companionMuted) return;
    this.stopCustomSample();
    const src = this.ctx.createBufferSource();
    src.buffer = this.customBuffer;
    src.loop = loop;
    src.connect(this.scratchGain);
    src.onended = () => {
      if (this.customSource === src) {
        this.customSource = null;
      }
    };
    src.start(0);
    this.customSource = src;
  }

  // ---- 合成打击乐器 ----
  playKick(time, startFreq = 115, decay = 0.22) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(36, time + decay);

    gain.gain.setValueAtTime(0.85, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay + 0.04);

    osc.connect(gain);
    gain.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + decay + 0.05);
  }

  playSnare(time, decay = 0.16) {
    // 噪声层
    const bufSize = Math.floor(this.ctx.sampleRate * decay);
    const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.35));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1100;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.55, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.beatGain);
    noise.start(time);

    // 鼓腔基频
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(195, time);
    osc.frequency.exponentialRampToValueAtTime(110, time + 0.08);
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
    hp.frequency.value = 6500;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.045);

    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.beatGain);
    src.start(time);
  }

  playClick(time, freq = 900, vol = 0.25) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
    osc.connect(gain);
    gain.connect(this.beatGain);
    osc.start(time);
    osc.stop(time + 0.04);
  }
}
