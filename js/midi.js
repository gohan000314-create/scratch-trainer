/**
 * Web MIDI 引擎（针对 Rane One 一代及常见 DJ 控制器深度优化）
 * - 支持 macOS CoreMIDI 多客户端共享（可与 Serato / djay 同时运行）
 * - 智能识别 7-bit 与 14-bit 高精度 Crossfader CC（自动合并 MSB + LSB）
 * - 支持多种转盘（Platter / Jog）相对/绝对编码及 Pitch Bend
 * - 配置自动持久化到 localStorage
 */

const STORAGE_KEY = 'scratch_trainer_midi_cfg_v1';

const DEFAULT_CONFIG = {
  fader: null, // { type: 'cc' | 'pb', channel, cc, lsbCc }
  platter: null, // { type: 'cc' | 'pb', channel, cc }
  hamster: false,
  faderSide: 'right', // 'right' | 'left'
  cutIn: 0.12, // 0.02 .. 0.45
  platterMode: 'auto', // 'auto' | 'rel_64' | 'rel_2c' | 'abs'
  platterSens: 1.0,
  platterInvert: false,
  scrollSpeed: 1.0, // 0.6 .. 2.0
  judgeWindowMs: 75 // 35 .. 130
};

export class MidiEngine {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.access = null;
    this.inputs = [];
    this.activeInputId = null;

    this.config = this.loadConfig();

    // 学习状态：null | 'fader' | 'platter'
    this.learningTarget = null;
    this._learnSamples = [];
    this._learnTimer = null;

    // 14-bit CC 缓存
    this._ccCache = new Map();

    // 实时硬件状态
    this.faderRaw = 0; // 0..1（经过侧向/Hamster映射后：0=关音，1=全开）
    this.faderOpen = false;
    this.platterPos = 0; // 归一化搓盘位移，范围约 [-1.2, 1.2]，中心/基准为 0
    this.platterVel = 0; // 瞬时速度
    this._lastAbsPlatter = null;
    this._detectedPlatterMode = null;
    this._platterAutoHistory = [];
  }

  loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
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
    this.saveConfig();
    this.callbacks.onConfigChanged?.(this.config);
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.callbacks.onSupportError?.(
        '当前浏览器不支持 Web MIDI API，请使用 Chrome 或 Edge 打开（macOS 上同样推荐使用 Chrome）。'
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
        `无法请求 MIDI 权限（请确认通过 localhost 访问并在浏览器中允许 MIDI 权限）：${err.message}`
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

    // 优先保持原选中设备；否则自动优先选中 RANE ONE 或任何已连接控制器
    let selected = this.inputs.find((i) => i.id === this.activeInputId);
    if (!selected && this.inputs.length > 0) {
      selected =
        this.inputs.find((i) => /rane\s*one/i.test(i.name || '')) ||
        this.inputs.find((i) => /rane|pioneer|ddj|djm|numark|reloop|traktor|denon/i.test(i.name || '')) ||
        this.inputs[0];
    }

    if (selected) {
      this.selectInput(selected.id);
    } else {
      this.activeInputId = null;
      this.callbacks.onDevicesChanged?.(this.inputs, null);
    }
  }

  selectInput(inputId) {
    for (const input of this.inputs) {
      input.onmidimessage = null;
    }
    const target = this.inputs.find((i) => i.id === inputId);
    if (!target) {
      this.activeInputId = null;
      this.callbacks.onDevicesChanged?.(this.inputs, null);
      return;
    }
    this.activeInputId = target.id;
    target.onmidimessage = (e) => this.handleMidiMessage(e);
    this.callbacks.onDevicesChanged?.(this.inputs, target);
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

  handleMidiMessage(event) {
    const [status, data1 = 0, data2 = 0] = event.data;
    const msgType = status & 0xf0;
    const channel = (status & 0x0f) + 1;

    // 过滤时钟/心跳类系统实时消息（0xF8 / 0xFE），避免刷屏
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
    this.callbacks.onRawLog?.(`[CH${channel}] ${typeLabel}  (${hex})`);

    // 若处于 MIDI Learn 模式，收集短时间内的样本来智能判定 MSB/LSB
    if (this.learningTarget) {
      if (msgType === 0xb0 || msgType === 0xe0) {
        this._learnSamples.push({ msgType, channel, data1, data2 });
        if (!this._learnTimer) {
          this._learnTimer = setTimeout(() => this.finishLearn(), 450);
        }
      }
      return;
    }

    // 缓存 CC 值以支持 14-bit 合并
    if (msgType === 0xb0) {
      this._ccCache.set(`${channel}:${data1}`, data2);
    }

    // 1. 匹配横推（Crossfader）
    if (this.config.fader) {
      const f = this.config.fader;
      if (f.type === 'cc' && msgType === 0xb0 && channel === f.channel) {
        if (data1 === f.cc || (f.lsbCc !== null && data1 === f.lsbCc)) {
          let norm = 0;
          if (f.lsbCc !== null) {
            const msb = this._ccCache.get(`${channel}:${f.cc}`) ?? 0;
            const lsb = this._ccCache.get(`${channel}:${f.lsbCc}`) ?? 0;
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

    // 2. 匹配转盘（Platter）
    if (this.config.platter) {
      const p = this.config.platter;
      if (p.type === 'cc' && msgType === 0xb0 && channel === p.channel && data1 === p.cc) {
        this.processPlatterCc(data2);
      } else if (p.type === 'pb' && msgType === 0xe0 && channel === p.channel) {
        const val = ((data2 << 7) | data1) - 8192;
        this.applyPlatterDelta((val / 8192) * 0.25);
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

    // 统计出现最多的 (msgType, channel, data1)
    const ccCounts = new Map();
    let pbSample = null;
    for (const s of samples) {
      if (s.msgType === 0xe0) {
        pbSample = s;
      } else if (s.msgType === 0xb0) {
        const key = `${s.channel}:${s.data1}`;
        ccCounts.set(key, (ccCounts.get(key) || 0) + 1);
      }
    }

    if (ccCounts.size > 0) {
      // 检查是否存在 14-bit MSB/LSB 对（例如 CC 8 和 CC 40 同时出现）
      const entries = Array.from(ccCounts.entries()).map(([k, count]) => {
        const [ch, cc] = k.split(':').map(Number);
        return { ch, cc, count };
      });
      entries.sort((a, b) => b.count - a.count);

      let chosen = entries[0];
      let lsbCc = null;

      if (target === 'fader') {
        // 如果同时出现 cc < 32 与 cc + 32，优先认定 cc 为 MSB，cc+32 为 LSB
        for (const e of entries) {
          if (e.cc < 32) {
            const pair = entries.find((o) => o.ch === e.ch && o.cc === e.cc + 32);
            if (pair) {
              chosen = e;
              lsbCc = pair.cc;
              break;
            }
          }
        }
        this.config.fader = {
          type: 'cc',
          channel: chosen.ch,
          cc: chosen.cc,
          lsbCc
        };
      } else if (target === 'platter') {
        this.config.platter = {
          type: 'cc',
          channel: chosen.ch,
          cc: chosen.cc
        };
        this._lastAbsPlatter = null;
        this._detectedPlatterMode = null;
        this._platterAutoHistory = [];
      }
    } else if (pbSample) {
      if (target === 'fader') {
        this.config.fader = { type: 'pb', channel: pbSample.channel, cc: null, lsbCc: null };
      } else {
        this.config.platter = { type: 'pb', channel: pbSample.channel, cc: null };
      }
    }

    this.saveConfig();
    this.callbacks.onLearnState?.(null);
    this.callbacks.onConfigChanged?.(this.config);
  }

  /**
   * 将 0..1 的物理横推位置转化为「出声开合度」（0 = 静音关音，1 = 全开）
   */
  updateFaderFromNormalized(physicalPos) {
    // 默认 right 侧：物理 0(最左)=关音，1(最右)=开音
    let openAmount = this.config.faderSide === 'right' ? physicalPos : 1 - physicalPos;
    if (this.config.hamster) {
      openAmount = 1 - openAmount;
    }
    this.setFaderLevel(openAmount);
  }

  /**
   * 外部输入（MIDI 或 键盘模拟）统一入口
   */
  setFaderLevel(level) {
    const clamped = Math.max(0, Math.min(1, level));
    const prevOpen = this.faderOpen;
    this.faderRaw = clamped;
    this.faderOpen = clamped >= this.config.cutIn;

    // 触发「关 -> 开」的上升沿事件（作为切音判定触发点）
    if (!prevOpen && this.faderOpen) {
      this.callbacks.onFaderCutOn?.(performance.now(), clamped);
    } else if (prevOpen && !this.faderOpen) {
      this.callbacks.onFaderCutOff?.(performance.now(), clamped);
    }
  }

  processPlatterCc(val) {
    let mode = this.config.platterMode;
    if (mode === 'auto') {
      this._platterAutoHistory.push(val);
      if (this._platterAutoHistory.length > 8) this._platterAutoHistory.shift();

      // 判断是否落在绝对位置典型中间区段（21..53 或 75..107）且变化连续
      const inMidZone = (v) => (v >= 21 && v <= 53) || (v >= 75 && v <= 107);
      const midCount = this._platterAutoHistory.filter(inMidZone).length;
      if (midCount >= 3) {
        this._detectedPlatterMode = 'abs';
      } else if (!this._detectedPlatterMode) {
        // 大多数 DJ 控制器相对转盘会在 63/65 附近（64偏移）或在 1..20 / 108..127 附近（二进制补码）
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
      delta = (val - 64) * 0.045;
    } else if (mode === 'rel_2c') {
      const signed = val < 64 ? val : val - 128;
      delta = signed * 0.045;
    } else if (mode === 'abs') {
      if (this._lastAbsPlatter !== null) {
        let diff = val - this._lastAbsPlatter;
        if (diff > 64) diff -= 128;
        if (diff < -64) diff += 128;
        delta = diff * 0.035;
      }
      this._lastAbsPlatter = val;
    }

    this.applyPlatterDelta(delta);
  }

  /**
   * 外部输入（MIDI 或 鼠标拖拽/滚轮模拟）统一入口
   */
  applyPlatterDelta(rawDelta) {
    const sign = this.config.platterInvert ? -1 : 1;
    const d = rawDelta * this.config.platterSens * sign;
    this.platterPos = Math.max(-1.1, Math.min(1.1, this.platterPos + d));
    this.platterVel = Math.max(-2.5, Math.min(2.5, this.platterVel * 0.4 + d * 18));
    this.callbacks.onPlatterMove?.(this.platterPos, this.platterVel, d);
  }

  /**
   * 每帧衰减瞬时速度（用于 UI 表与音频停止）
   */
  tickDecay(dt) {
    const decay = Math.exp(-dt * 14);
    this.platterVel *= decay;
    if (Math.abs(this.platterVel) < 0.005) {
      this.platterVel = 0;
    }
  }
}
