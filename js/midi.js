/**
 * 通用 DJ 控制器 / 碟机 Web MIDI 引擎（v3 全设备兼容版）
 * - 支持全部主流品牌与分体机：Pioneer DJ / AlphaTheta (DDJ/CDJ/DJM/REV)、Rane (One/Performer/Twelve/Seventy)、
 *   Denon DJ、Numark、Reloop、Traktor、Hercules、Roland、Phase 及任意标准 USB-MIDI / CoreMIDI 设备
 * - 支持「全部 MIDI 设备同时监听」：混音台横推 + 独立转盘/CDJ 分离接入也能同时绑定
 * - 支持 Left Deck / Right Deck 独立转盘映射与视图联动
 * - 智能识别 7-bit / 14-bit 高精度 Crossfader & Platter CC（自动合并 MSB + LSB）及 Pitch Bend
 * - 支持相对 64 偏移 / 二进制补码 / 符号位 / 绝对位置 4 种转盘编码自动识别
 * - 横推施密特迟滞 + 防抖，转盘丝滑插值滤波
 */

const STORAGE_KEY = 'scratch_trainer_midi_cfg_v1';
export const ALL_INPUTS_ID = '__ALL__';

const DEFAULT_CONFIG = {
  activeDeck: 'right', // 'left' | 'right'
  fader: null, // { type: 'cc' | 'pb', deviceName, channel, cc, lsbCc }
  platter: null, // 兼容旧版单转盘绑定
  platterLeft: null, // { type: 'cc' | 'pb', deviceName, channel, cc, lsbCc }
  platterRight: null, // { type: 'cc' | 'pb', deviceName, channel, cc, lsbCc }
  hamster: false,
  faderSide: 'right', // 'right' | 'left'（随 activeDeck 自动联动，也可单独微调）
  cutIn: 0.18, // 0.02 .. 0.45
  platterMode: 'auto', // 'auto' | 'rel_64' | 'rel_2c' | 'rel_signbit' | 'abs'
  platterSens: 0.8,
  platterInvert: false,
  scrollSpeed: 1.0, // 0.6 .. 2.0
  judgeWindowMs: 75 // 35 .. 130
};

export class MidiEngine {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.access = null;
    this.inputs = [];
    this.activeInputId = ALL_INPUTS_ID;

    this.config = this.loadConfig();

    // 学习状态：null | 'fader' | 'platter'
    this.learningTarget = null;
    this._learnSamples = [];
    this._learnTimer = null;

    // 14-bit CC 缓存（按 deviceId:channel:cc 隔离，支持多设备）
    this._ccCache = new Map();

    // 实时硬件状态
    this.faderRaw = 0;
    this.faderOpen = false;
    this._lastFaderEdgeTime = 0;

    this.platterPos = 0;
    this._platterTargetPos = 0;
    this.platterVel = 0;
    this._lastAbsPlatter = null;
    this._detectedPlatterMode = null;
    this._platterAutoHistory = [];
  }

  loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
        // 向下兼容旧版单转盘映射
        if (parsed.platter && !parsed.platterRight && !parsed.platterLeft) {
          if (parsed.activeDeck === 'left') parsed.platterLeft = parsed.platter;
          else parsed.platterRight = parsed.platter;
        }
        return parsed;
      }
    } catch (_) {
      // 忽略存储读取异常
    }
    return { ...DEFAULT_CONFIG };
  }

  saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (_) {
      // 忽略
    }
  }

  resetConfig() {
    this.config = { ...DEFAULT_CONFIG };
    this._lastAbsPlatter = null;
    this._detectedPlatterMode = null;
    this._platterAutoHistory = [];
    this.saveConfig();
    this.callbacks.onConfigChanged?.(this.config);
  }

  getActivePlatterMapping() {
    return this.config.activeDeck === 'left'
      ? this.config.platterLeft || this.config.platter
      : this.config.platterRight || this.config.platter;
  }

  setActiveDeck(deck) {
    const nextDeck = deck === 'left' ? 'left' : 'right';
    this.config.activeDeck = nextDeck;
    this.config.faderSide = nextDeck;
    this._lastAbsPlatter = null;
    this._detectedPlatterMode = null;
    this._platterAutoHistory = [];
    this.resetPlatter();
    this.saveConfig();
    this.callbacks.onConfigChanged?.(this.config);
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.callbacks.onSupportError?.(
        '当前浏览器不支持 Web MIDI API，请使用正式版 Google Chrome 或 Microsoft Edge 打开。'
      );
      return false;
    }

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.refreshInputs();
      this.refreshInputs();
      return true;
    } catch (err) {
      this.callbacks.onSupportError?.(
        `无法获取 MIDI 权限（请在浏览器地址栏左侧允许 MIDI 设备权限后刷新）：${err.message}`
      );
      return false;
    }
  }

  refreshInputs() {
    if (!this.access) return;
    this.inputs = Array.from(this.access.inputs.values());

    // 先解绑旧回调
    for (const input of this.inputs) {
      input.onmidimessage = null;
    }

    if (this.inputs.length === 0) {
      this.callbacks.onDevicesChanged?.(this.inputs, null, ALL_INPUTS_ID);
      return;
    }

    // 默认保持全部设备监听，或保持用户已选定的单设备
    if (this.activeInputId !== ALL_INPUTS_ID) {
      const exists = this.inputs.some((i) => i.id === this.activeInputId);
      if (!exists) {
        this.activeInputId = ALL_INPUTS_ID;
      }
    }

    this.selectInput(this.activeInputId);
  }

  selectInput(inputId) {
    for (const input of this.inputs) {
      input.onmidimessage = null;
    }

    if (this.inputs.length === 0) {
      this.activeInputId = ALL_INPUTS_ID;
      this.callbacks.onDevicesChanged?.(this.inputs, null, ALL_INPUTS_ID);
      return;
    }

    if (inputId === ALL_INPUTS_ID || !inputId) {
      this.activeInputId = ALL_INPUTS_ID;
      for (const input of this.inputs) {
        input.onmidimessage = (e) => this.handleMidiMessage(e, input);
      }
      this.callbacks.onDevicesChanged?.(this.inputs, this.inputs[0], ALL_INPUTS_ID);
      return;
    }

    const target = this.inputs.find((i) => i.id === inputId);
    if (!target) {
      this.selectInput(ALL_INPUTS_ID);
      return;
    }

    this.activeInputId = target.id;
    target.onmidimessage = (e) => this.handleMidiMessage(e, target);
    this.callbacks.onDevicesChanged?.(this.inputs, target, target.id);
  }

  startLearn(target) {
    this.learningTarget = target; // 'fader' | 'platter'
    this._learnSamples = [];
    if (this._learnTimer) clearTimeout(this._learnTimer);
    this.callbacks.onLearnState?.(target);
  }

  cancelLearn() {
    this.learningTarget = null;
    this._learnSamples = [];
    if (this._learnTimer) clearTimeout(this._learnTimer);
    this.callbacks.onLearnState?.(null);
  }

  handleMidiMessage(event, sourceInput) {
    const [status, data1 = 0, data2 = 0] = event.data;
    const msgType = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const deviceId = sourceInput?.id || 'default';
    const deviceName = sourceInput?.name || 'MIDI';

    // 过滤系统实时消息（0xF8 时钟 / 0xFE 心跳），避免刷屏
    if (status >= 0xf0) return;

    // 原始日志回调
    const hex = Array.from(event.data)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    const typeLabel =
      msgType === 0xb0
        ? `CC#${data1}=${data2}`
        : msgType === 0xe0
          ? `PitchBend=${(data2 << 7) | data1}`
          : msgType === 0x90
            ? `NoteOn#${data1}=${data2}`
            : msgType === 0x80
              ? `NoteOff#${data1}`
              : `0x${msgType.toString(16)}`;
    const shortDev = deviceName.length > 14 ? `${deviceName.slice(0, 14)}…` : deviceName;
    this.callbacks.onRawLog?.(`[${shortDev} CH${channel}] ${typeLabel} (${hex})`);

    // 若处于 MIDI Learn 模式，收集短时间内的样本以智能判定 7-bit / 14-bit MSB+LSB / PitchBend
    if (this.learningTarget) {
      if (msgType === 0xb0 || msgType === 0xe0) {
        this._learnSamples.push({ msgType, channel, data1, data2, deviceName });
        if (!this._learnTimer) {
          this._learnTimer = setTimeout(() => this.finishLearn(), 480);
        }
      }
      return;
    }

    // 缓存 CC 值以支持 14-bit 合并
    if (msgType === 0xb0) {
      this._ccCache.set(`${deviceId}:${channel}:${data1}`, data2);
    }

    // 1. 匹配横推（Crossfader）
    if (this.config.fader) {
      const f = this.config.fader;
      const devMatch = !f.deviceName || f.deviceName === deviceName || this.inputs.length === 1;
      if (devMatch) {
        if (f.type === 'cc' && msgType === 0xb0 && channel === f.channel) {
          if (data1 === f.cc || (f.lsbCc !== null && data1 === f.lsbCc)) {
            let norm = 0;
            if (f.lsbCc !== null) {
              const msb = this._ccCache.get(`${deviceId}:${channel}:${f.cc}`) ?? 0;
              const lsb = this._ccCache.get(`${deviceId}:${channel}:${f.lsbCc}`) ?? 0;
              norm = ((msb << 7) | lsb) / 16383;
            } else {
              norm = data2 / 127;
            }
            this.updateFaderFromNormalized(norm);
          }
        } else if (f.type === 'pb' && msgType === 0xe0 && channel === f.channel) {
          const norm = ((data2 << 7) | data1) / 16383;
          this.updateFaderFromNormalized(norm);
        }
      }
    }

    // 2. 匹配当前 Deck 的转盘（Platter / Jog）
    const p = this.getActivePlatterMapping();
    if (p) {
      const devMatch = !p.deviceName || p.deviceName === deviceName || this.inputs.length === 1;
      if (devMatch) {
        if (p.type === 'cc' && msgType === 0xb0 && channel === p.channel) {
          if (p.lsbCc !== null && p.lsbCc !== undefined) {
            if (data1 === p.cc || data1 === p.lsbCc) {
              const msb = this._ccCache.get(`${deviceId}:${channel}:${p.cc}`) ?? 0;
              const lsb = this._ccCache.get(`${deviceId}:${channel}:${p.lsbCc}`) ?? 0;
              this.processPlatter14Bit((msb << 7) | lsb);
            }
          } else if (data1 === p.cc) {
            this.processPlatterCc(data2);
          }
        } else if (p.type === 'pb' && msgType === 0xe0 && channel === p.channel) {
          const val = ((data2 << 7) | data1) - 8192;
          this.applyPlatterDelta((val / 8192) * 0.055);
        }
      }
    }
  }

  finishLearn() {
    this._learnTimer = null;
    const target = this.learningTarget;
    const samples = this._learnSamples;
    this.learningTarget = null;
    this._learnSamples = [];

    if (!target || samples.length === 0) {
      this.callbacks.onLearnState?.(null);
      return;
    }

    const ccCounts = new Map();
    let pbSample = null;
    for (const s of samples) {
      if (s.msgType === 0xe0) {
        pbSample = s;
      } else if (s.msgType === 0xb0) {
        const key = `${s.deviceName}||${s.channel}||${s.data1}`;
        ccCounts.set(key, (ccCounts.get(key) || 0) + 1);
      }
    }

    let mapping = null;
    if (ccCounts.size > 0) {
      const entries = Array.from(ccCounts.entries()).map(([k, count]) => {
        const [deviceName, chStr, ccStr] = k.split('||');
        return { deviceName, ch: Number(chStr), cc: Number(ccStr), count };
      });
      entries.sort((a, b) => b.count - a.count);

      let chosen = entries[0];
      let lsbCc = null;

      // 同时检测横推与转盘的 14-bit MSB/LSB 对（例如 CC 8 + CC 40，Pioneer/Rane/Denon 均常见）
      for (const e of entries) {
        if (e.cc < 32) {
          const pair = entries.find(
            (o) => o.deviceName === e.deviceName && o.ch === e.ch && o.cc === e.cc + 32
          );
          if (pair) {
            chosen = e;
            lsbCc = pair.cc;
            break;
          }
        }
      }

      mapping = {
        type: 'cc',
        deviceName: chosen.deviceName,
        channel: chosen.ch,
        cc: chosen.cc,
        lsbCc
      };
    } else if (pbSample) {
      mapping = {
        type: 'pb',
        deviceName: pbSample.deviceName,
        channel: pbSample.channel,
        cc: null,
        lsbCc: null
      };
    }

    if (mapping) {
      if (target === 'fader') {
        this.config.fader = mapping;
      } else if (target === 'platter') {
        if (this.config.activeDeck === 'left') {
          this.config.platterLeft = mapping;
        } else {
          this.config.platterRight = mapping;
        }
        this.config.platter = mapping;
        this._lastAbsPlatter = null;
        this._detectedPlatterMode = null;
        this._platterAutoHistory = [];
      }
    }

    this.saveConfig();
    this.callbacks.onLearnState?.(null);
    this.callbacks.onConfigChanged?.(this.config);
  }

  updateFaderFromNormalized(physicalPos) {
    let openAmount = this.config.faderSide === 'right' ? physicalPos : 1 - physicalPos;
    if (this.config.hamster) {
      openAmount = 1 - openAmount;
    }
    this.setFaderLevel(openAmount);
  }

  /**
   * 外部输入（MIDI 或 键盘模拟）统一入口
   * 加入施密特触发器迟滞（Hysteresis）与 24ms 防抖，杜绝横推临界点微颤误触发
   */
  setFaderLevel(level) {
    const clamped = Math.max(0, Math.min(1, level));
    const prevOpen = this.faderOpen;
    this.faderRaw = clamped;

    const cutIn = this.config.cutIn;
    const hysteresis = 0.04;
    const cutOut = Math.max(0.01, cutIn - hysteresis);

    let nextOpen = prevOpen;
    if (!prevOpen && clamped >= cutIn) {
      nextOpen = true;
    } else if (prevOpen && clamped <= cutOut) {
      nextOpen = false;
    }

    const now = performance.now();
    if (nextOpen !== prevOpen) {
      const isExtremeJump = clamped <= 0.01 || clamped >= 0.99;
      if (!isExtremeJump && now - this._lastFaderEdgeTime < 24) {
        return;
      }
      this._lastFaderEdgeTime = now;
      this.faderOpen = nextOpen;

      if (nextOpen) {
        this.callbacks.onFaderCutOn?.(now, clamped);
      } else {
        this.callbacks.onFaderCutOff?.(now, clamped);
      }
    }
  }

  /**
   * 14-bit 转盘位置增量解析（适用于部分 Pioneer / Denon / 高精度转盘）
   */
  processPlatter14Bit(val14) {
    if (this._lastAbsPlatter !== null) {
      let diff = val14 - this._lastAbsPlatter;
      if (diff > 8192) diff -= 16384;
      if (diff < -8192) diff += 16384;
      this.applyPlatterDelta((diff / 16384) * 3.2);
    }
    this._lastAbsPlatter = val14;
  }

  processPlatterCc(val) {
    let mode = this.config.platterMode;
    if (mode === 'auto') {
      this._platterAutoHistory.push(val);
      if (this._platterAutoHistory.length > 8) this._platterAutoHistory.shift();

      const inMidZone = (v) => (v >= 21 && v <= 53) || (v >= 75 && v <= 107);
      const midCount = this._platterAutoHistory.filter(inMidZone).length;
      if (midCount >= 3) {
        this._detectedPlatterMode = 'abs';
      } else if (!this._detectedPlatterMode) {
        if (val >= 54 && val <= 74 && val !== 64) {
          this._detectedPlatterMode = 'rel_64';
        } else if ((val >= 1 && val <= 20) || (val >= 108 && val <= 127)) {
          this._detectedPlatterMode = 'rel_2c';
        }
      }
      mode = this._detectedPlatterMode || 'rel_64';
    } else {
      this._detectedPlatterMode = null;
    }

    let delta = 0;
    if (mode === 'rel_64') {
      delta = (val - 64) * 0.011;
    } else if (mode === 'rel_2c') {
      const signed = val < 64 ? val : val - 128;
      delta = signed * 0.011;
    } else if (mode === 'rel_signbit') {
      const signed = val < 64 ? val : -(val - 64);
      delta = signed * 0.011;
    } else if (mode === 'abs') {
      if (this._lastAbsPlatter !== null) {
        let diff = val - this._lastAbsPlatter;
        if (diff > 64) diff -= 128;
        if (diff < -64) diff += 128;
        delta = diff * 0.009;
      }
      this._lastAbsPlatter = val;
    }

    this.applyPlatterDelta(delta);
  }

  applyPlatterDelta(rawDelta) {
    const sign = this.config.platterInvert ? -1 : 1;
    const d = rawDelta * this.config.platterSens * sign;
    this._platterTargetPos = Math.max(-1.05, Math.min(1.05, this._platterTargetPos + d));
    this.platterVel = Math.max(-2.2, Math.min(2.2, this.platterVel * 0.55 + d * 6.5));
    this.callbacks.onPlatterMove?.(this.platterPos, this.platterVel, d);
  }

  resetPlatter() {
    this.platterPos = 0;
    this._platterTargetPos = 0;
    this.platterVel = 0;
  }

  tickDecay(dt) {
    const posLerp = 1 - Math.exp(-dt * 28);
    this.platterPos += (this._platterTargetPos - this.platterPos) * posLerp;

    const decay = Math.exp(-dt * 11);
    this.platterVel *= decay;
    if (Math.abs(this.platterVel) < 0.005) {
      this.platterVel = 0;
    }
  }
}
