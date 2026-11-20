/**
 * 高帧率 Canvas 渲染与音游判定引擎
 * 高度还原视频视觉：
 * - 垂直向下滚动的节拍网格（Bar / Beat / Subdivision）
 * - Fader 模式：`<` 切音标记下落、命中变亮绿 `X`、判定线下方实时白色横推脉冲波形
 * - Platter 模式：标准 TTM 曲线滚动、实时玩家搓盘曲线与误差着色
 * - Combo / Free 模式：双轨合一的完整 TTM 示波器
 */

export class StageRenderer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;

    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.scrollSpeed = 1.0; // 1.0x 基础流速
    this.judgeWindowMs = 75; // ±75ms 判定窗口

    // 历史轨迹环缓冲：{ beat, fader, faderOpen, platter, targetPlatter }
    this.history = [];
    this.maxHistoryBeats = 8;

    // 已生成/已判定的 Fader 音符状态：Map<noteKey, { beat, status: 'pending'|'perfect'|'good'|'miss', diffMs }>
    this.noteStates = new Map();

    // Platter 连续准确度采样
    this.platterScoreSum = 0;
    this.platterScoreCount = 0;

    // 统计数据
    this.stats = {
      hits: 0,
      total: 0,
      combo: 0,
      maxCombo: 0,
      accuracy: 100,
      faderAccuracy: 100,
      platterAccuracy: 100
    };

    // 命中闪光粒子/波纹
    this.flashes = [];

    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  reset() {
    this.history = [];
    this.noteStates.clear();
    this.flashes = [];
    this.platterScoreSum = 0;
    this.platterScoreCount = 0;
    this.stats = {
      hits: 0,
      total: 0,
      combo: 0,
      maxCombo: 0,
      accuracy: 100,
      faderAccuracy: 100,
      platterAccuracy: 100
    };
    this.callbacks.onStatsChanged?.(this.stats);
  }

  /**
   * 每拍在屏幕上的像素高度
   */
  getPixelsPerBeat() {
    return Math.max(90, this.height * 0.22) * this.scrollSpeed;
  }

  /**
   * 判定线 Y 坐标（还原视频中下部位置）
   */
  getJudgeY() {
    return this.height * 0.62;
  }

  /**
   * 将任意拍数转为当前屏幕 Y 坐标（未来拍在上方，历史拍在下方，自上而下滚动）
   */
  beatToY(beat, currentBeat) {
    const ppb = this.getPixelsPerBeat();
    return this.getJudgeY() - (beat - currentBeat) * ppb;
  }

  /**
   * 记录一帧实时输入历史，用于绘制下方波形与计算 Platter 准确度
   */
  recordSample(currentBeat, mode, pattern, faderRaw, faderOpen, platterPos) {
    let targetPlatter = null;
    if (pattern && typeof pattern.platterFn === 'function') {
      const loopB = ((currentBeat % pattern.loopBeats) + pattern.loopBeats) % pattern.loopBeats;
      targetPlatter = pattern.platterFn(loopB);

      // Platter / Combo 模式下统计曲线贴合度
      if ((mode === 'platter' || mode === 'combo') && currentBeat >= 0) {
        const err = Math.abs(platterPos - targetPlatter);
        const frameAcc = Math.max(0, 1 - err / 0.65);
        this.platterScoreSum += frameAcc;
        this.platterScoreCount += 1;
        if (this.platterScoreCount % 8 === 0) {
          this.stats.platterAccuracy = Math.round((this.platterScoreSum / this.platterScoreCount) * 100);
          this.recomputeOverallAccuracy(mode);
          this.callbacks.onStatsChanged?.(this.stats);
        }
      }
    }

    this.history.push({
      beat: currentBeat,
      fader: faderRaw,
      faderOpen,
      platter: platterPos,
      targetPlatter
    });

    // 清理过旧历史
    const minBeat = currentBeat - this.maxHistoryBeats;
    while (this.history.length > 0 && this.history[0].beat < minBeat) {
      this.history.shift();
    }
  }

  /**
   * 获取当前视野内所有的 Fader 音符（并自动标记已错过音符为 miss）
   */
  syncFaderNotes(currentBeat, bpm, pattern, mode) {
    if (!pattern || !pattern.faderNotes || pattern.faderNotes.length === 0) return [];
    if (mode !== 'fader' && mode !== 'combo') return [];

    const ppb = this.getPixelsPerBeat();
    const lookAheadBeats = this.getJudgeY() / ppb + 1.5;
    const lookBehindBeats = (this.height - this.getJudgeY()) / ppb + 1.5;

    const minBeat = Math.max(0, currentBeat - lookBehindBeats);
    const maxBeat = currentBeat + lookAheadBeats;

    const startCycle = Math.floor(minBeat / pattern.loopBeats);
    const endCycle = Math.floor(maxBeat / pattern.loopBeats);

    const visibleNotes = [];
    const missWindowBeats = (this.judgeWindowMs * 1.45 / 1000) * (bpm / 60);

    for (let c = startCycle; c <= endCycle; c++) {
      if (c < 0) continue;
      for (let i = 0; i < pattern.faderNotes.length; i++) {
        const noteBeat = c * pattern.loopBeats + pattern.faderNotes[i];
        if (noteBeat < minBeat || noteBeat > maxBeat) continue;

        const key = `${c}:${i}`;
        let state = this.noteStates.get(key);
        if (!state) {
          state = { key, beat: noteBeat, status: 'pending', diffMs: 0 };
          this.noteStates.set(key, state);
        }

        // 超过窗口仍未命中 -> 判 Miss
        if (state.status === 'pending' && currentBeat - noteBeat > missWindowBeats) {
          state.status = 'miss';
          this.stats.total += 1;
          this.stats.combo = 0;
          this.updateAccuracy(mode);
          this.callbacks.onJudge?.('MISS', 'miss', 0);
        }

        visibleNotes.push(state);
      }
    }

    // 清理很早之前的音符缓存
    if (this.noteStates.size > 400) {
      for (const [k, v] of this.noteStates) {
        if (v.beat < currentBeat - 12) this.noteStates.delete(k);
      }
    }

    return visibleNotes;
  }

  /**
   * 当横推触发切音沿时调用（支持按谱面要求匹配上升沿 open 或下降沿 close）
   */
  handleFaderCutTrigger(currentBeat, bpm, mode, pattern, edge = 'open') {
    if (mode !== 'fader' && mode !== 'combo') return;
    if (!pattern || !pattern.faderNotes || pattern.faderNotes.length === 0) return;

    const expectedEdge = pattern.faderCutEdge || 'open';
    if (edge !== expectedEdge) return;

    const secPerBeat = 60 / bpm;
    let bestNote = null;
    let bestAbsMs = Infinity;
    let signedMs = 0;

    for (const state of this.noteStates.values()) {
      if (state.status !== 'pending') continue;
      const diffMs = (currentBeat - state.beat) * secPerBeat * 1000;
      const absMs = Math.abs(diffMs);
      if (absMs < bestAbsMs) {
        bestAbsMs = absMs;
        bestNote = state;
        signedMs = diffMs;
      }
    }

    const perfectMs = this.judgeWindowMs * 0.58;
    const goodMs = this.judgeWindowMs * 1.35;

    if (bestNote && bestAbsMs <= goodMs) {
      const isPerfect = bestAbsMs <= perfectMs;
      bestNote.status = isPerfect ? 'perfect' : 'good';
      bestNote.diffMs = signedMs;

      this.stats.hits += 1;
      this.stats.total += 1;
      this.stats.combo += 1;
      if (this.stats.combo > this.stats.maxCombo) {
        this.stats.maxCombo = this.stats.combo;
      }
      this.updateAccuracy(mode);

      this.flashes.push({
        t: 1.0,
        color: isPerfect ? '#22e58b' : '#f5b942'
      });

      this.callbacks.onJudge?.(
        isPerfect ? 'PERFECT' : signedMs < 0 ? 'EARLY' : 'LATE',
        isPerfect ? 'perfect' : 'good',
        Math.round(signedMs)
      );
    }
  }

  recomputeOverallAccuracy(mode) {
    if (mode === 'platter') {
      this.stats.accuracy = this.stats.platterAccuracy;
    } else if (mode === 'combo') {
      if (this.stats.total > 0 && this.platterScoreCount > 0) {
        this.stats.accuracy = Math.round(
          this.stats.faderAccuracy * 0.6 + this.stats.platterAccuracy * 0.4
        );
      } else if (this.stats.total > 0) {
        this.stats.accuracy = this.stats.faderAccuracy;
      } else {
        this.stats.accuracy = this.stats.platterAccuracy;
      }
    } else {
      this.stats.accuracy = this.stats.faderAccuracy;
    }
  }

  updateAccuracy(mode = 'fader') {
    if (this.stats.total > 0) {
      this.stats.faderAccuracy = Math.round((this.stats.hits / this.stats.total) * 100);
    }
    this.recomputeOverallAccuracy(mode);
    this.callbacks.onStatsChanged?.(this.stats);
  }

  /**
   * 主绘制函数
   */
  render({ currentBeat, bpm, mode, pattern, faderRaw, faderOpen, platterPos, isPlaying }) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const judgeY = this.getJudgeY();

    // 1. 清屏（深黑背景）
    ctx.clearRect(0, 0, W, H);

    // 2. 绘制滚动节拍网格
    this.drawBeatGrid(ctx, W, H, currentBeat, pattern);

    // 3. 根据模式绘制主视觉内容
    if (mode === 'fader') {
      this.drawFaderMode(ctx, W, H, judgeY, currentBeat, bpm, pattern, faderRaw, faderOpen);
    } else if (mode === 'platter') {
      this.drawPlatterMode(ctx, W, H, judgeY, currentBeat, pattern, platterPos);
    } else if (mode === 'combo') {
      this.drawComboMode(ctx, W, H, judgeY, currentBeat, bpm, pattern, faderRaw, faderOpen, platterPos);
    } else {
      this.drawFreeMode(ctx, W, H, judgeY, currentBeat, faderRaw, faderOpen, platterPos);
    }

    // 4. 命中判定线闪光特效
    this.drawFlashes(ctx, W, judgeY);

    // 5. 未开始播放时的轻提示水印
    if (!isPlaying && this.history.length < 3) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.font = W < 460
        ? '600 12px -apple-system, BlinkMacSystemFont, sans-serif'
        : '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        W < 460 ? '点「开始」或按回车启动' : '点击下方「▶ 开始练习」或按回车键启动谱面滚动',
        W / 2,
        judgeY - 36
      );
      ctx.restore();
    }
  }

  drawBeatGrid(ctx, W, H, currentBeat, pattern) {
    const ppb = this.getPixelsPerBeat();
    const loopBeats = pattern?.loopBeats || 4;
    const sub = pattern?.subdivision || 2;
    const step = 1 / sub;

    const minBeat = Math.floor((currentBeat - (H - this.getJudgeY()) / ppb - 1) / step) * step;
    const maxBeat = Math.ceil((currentBeat + this.getJudgeY() / ppb + 1) / step) * step;

    ctx.save();
    for (let b = minBeat; b <= maxBeat; b += step) {
      const y = this.beatToY(b, currentBeat);
      if (y < -10 || y > H + 10) continue;

      const rounded = Math.round(b * 1000) / 1000;
      const isBar = Math.abs(rounded % loopBeats) < 0.001 && rounded >= 0;
      const isBeat = Math.abs(rounded % 1) < 0.001;

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);

      if (isBar) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.lineWidth = 1.2;
      } else if (isBeat) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.032)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();

      // 在左侧显示小节序号
      if (isBar && rounded >= 0) {
        const barNum = Math.round(rounded / loopBeats) + 1;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.font = '600 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`BAR ${barNum}`, 16, y - 5);
      }
    }
    ctx.restore();
  }

  /**
   * Fader 模式：1:1 复刻视频 00:00 - 00:09 效果
   * 左侧基准轴 + 下落 `<` 标记 + 命中变绿 `X` + 右侧白色脉冲波形
   */
  drawFaderMode(ctx, W, H, judgeY, currentBeat, bpm, pattern, faderRaw, faderOpen) {
    const isNarrow = W < 460;
    const baseX = isNarrow ? W * 0.22 : W * 0.36; // 垂直基准轴（横推关闭位）
    const waveMaxW = isNarrow ? W * 0.64 : Math.min(W * 0.48, 360); // 横推全开时的波形振幅宽度

    // 1. 绘制垂直基准轴
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(baseX, 0);
    ctx.lineTo(baseX, H);
    ctx.stroke();

    // 2. 绘制历史横推波形（判定线下方，发光白线）
    if (this.history.length > 1) {
      ctx.beginPath();
      let started = false;
      for (let i = this.history.length - 1; i >= 0; i--) {
        const pt = this.history[i];
        const y = this.beatToY(pt.beat, currentBeat);
        if (y < judgeY - 2) continue;
        if (y > H + 20) break;
        const x = baseX + pt.fader * waveMaxW;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = 'rgba(235, 242, 255, 0.88)';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.45)';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // 3. 绘制水平发光判定线
    const grad = ctx.createLinearGradient(baseX - 40, 0, baseX + waveMaxW + 80, 0);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    grad.addColorStop(0.15, 'rgba(255, 255, 255, 0.92)');
    grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.72)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.65)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(baseX - 40, judgeY);
    ctx.lineTo(baseX + waveMaxW + 80, judgeY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 4. 绘制滚动的 `<` 切音标记与命中绿 `X`
    const notes = this.syncFaderNotes(currentBeat, bpm, pattern, 'fader');
    for (const n of notes) {
      const y = this.beatToY(n.beat, currentBeat);
      if (y < -30 || y > H + 30) continue;

      if (n.status === 'pending') {
        // 未来未命中的 `<` 标记（复刻视频精致的细白尖括号）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(baseX + 12, y - 10);
        ctx.lineTo(baseX - 8, y);
        ctx.lineTo(baseX + 12, y + 10);
        ctx.stroke();
      } else if (n.status === 'perfect' || n.status === 'good') {
        // 命中：高亮发光绿色 X（复刻视频绿叉）
        const color = n.status === 'perfect' ? '#22e58b' : '#f5b942';
        this.drawCrossMark(ctx, baseX, y, 12, color, 3.0, 14);
      } else if (n.status === 'miss') {
        // 漏切：红色小叉
        this.drawCrossMark(ctx, baseX, y, 8, 'rgba(255, 77, 109, 0.78)', 2.0, 6);
      }
    }

    // 5. 判定线上的实时横推白 X 光标
    const cursorX = baseX + faderRaw * waveMaxW;
    this.drawCrossMark(
      ctx,
      cursorX,
      judgeY,
      9,
      faderOpen ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
      2.4,
      faderOpen ? 16 : 6
    );

    ctx.restore();
  }

  /**
   * Platter 模式：1:1 复刻视频 00:10 - 00:18 效果
   * 标准 TTM 搓盘曲线滚动 + 实时玩家搓盘曲线重合度发光着色
   */
  drawPlatterMode(ctx, W, H, judgeY, currentBeat, pattern, platterPos) {
    const isNarrow = W < 460;
    const centerX = isNarrow ? W * 0.26 : W * 0.45;
    const ampX = isNarrow ? W * 0.56 : Math.min(W * 0.24, 175);

    ctx.save();

    // 1. 基准垂直线（唱片起点）
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, H);
    ctx.stroke();

    // 2. 绘制标准目标 TTM 搓盘曲线（覆盖全屏：上方未来谱面 + 下方参照线）
    if (pattern && typeof pattern.platterFn === 'function') {
      const ppb = this.getPixelsPerBeat();
      const stepPx = 3;
      ctx.beginPath();
      for (let y = 0; y <= H; y += stepPx) {
        const beat = currentBeat + (judgeY - y) / ppb;
        const loopB = ((beat % pattern.loopBeats) + pattern.loopBeats) % pattern.loopBeats;
        const val = pattern.platterFn(loopB);
        const x = centerX + val * ampX;
        if (y === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }

    // 3. 绘制玩家实时搓盘轨迹（判定线下方，根据与目标曲线误差动态变色）
    if (this.history.length > 1) {
      for (let i = this.history.length - 1; i >= 1; i--) {
        const p1 = this.history[i];
        const p0 = this.history[i - 1];
        const y1 = this.beatToY(p1.beat, currentBeat);
        const y0 = this.beatToY(p0.beat, currentBeat);
        if (y1 < judgeY - 2) continue;
        if (y0 > H + 20) break;

        const x1 = centerX + p1.platter * ampX;
        const x0 = centerX + p0.platter * ampX;

        let segColor = '#ffffff';
        if (p1.targetPlatter !== null) {
          const err = Math.abs(p1.platter - p1.targetPlatter);
          if (err < 0.22) segColor = '#22e58b';
          else if (err < 0.45) segColor = '#f5b942';
          else segColor = '#ff5c7c';
        }

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x0, y0);
        ctx.strokeStyle = segColor;
        ctx.lineWidth = 3.0;
        ctx.shadowColor = segColor;
        ctx.shadowBlur = 8;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // 4. 水平判定线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(centerX - ampX * 0.6, judgeY);
    ctx.lineTo(centerX + ampX * 1.35, judgeY);
    ctx.stroke();

    // 5. 判定线上的实时玩家搓盘白 X 光标
    const cursorX = centerX + platterPos * ampX;
    this.drawCrossMark(ctx, cursorX, judgeY, 9, '#ffffff', 2.4, 14);

    ctx.restore();
  }

  /**
   * Combo 综合模式：同时展示转盘 TTM 曲线 + 横推切音点
   * 横推开音时玩家轨迹为高亮实线，关音时为暗灰虚线
   */
  drawComboMode(ctx, W, H, judgeY, currentBeat, bpm, pattern, faderRaw, faderOpen, platterPos) {
    const isNarrow = W < 460;
    const centerX = isNarrow ? W * 0.32 : W * 0.46;
    const ampX = isNarrow ? W * 0.52 : Math.min(W * 0.22, 165);
    const faderTrackX = isNarrow ? W * 0.14 : centerX - ampX * 0.55;

    ctx.save();

    // 左侧横推切音基准轨
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(faderTrackX, 0);
    ctx.lineTo(faderTrackX, H);
    ctx.stroke();

    // 标准转盘曲线
    if (pattern && typeof pattern.platterFn === 'function') {
      const ppb = this.getPixelsPerBeat();
      ctx.beginPath();
      for (let y = 0; y <= H; y += 3) {
        const beat = currentBeat + (judgeY - y) / ppb;
        const loopB = ((beat % pattern.loopBeats) + pattern.loopBeats) % pattern.loopBeats;
        const x = centerX + pattern.platterFn(loopB) * ampX;
        if (y === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    // 玩家轨迹（开音=高亮实线，关音=暗灰细线）
    if (this.history.length > 1) {
      for (let i = this.history.length - 1; i >= 1; i--) {
        const p1 = this.history[i];
        const p0 = this.history[i - 1];
        const y1 = this.beatToY(p1.beat, currentBeat);
        const y0 = this.beatToY(p0.beat, currentBeat);
        if (y1 < judgeY - 2) continue;
        if (y0 > H + 20) break;

        ctx.beginPath();
        ctx.moveTo(centerX + p1.platter * ampX, y1);
        ctx.lineTo(centerX + p0.platter * ampX, y0);
        if (p1.faderOpen) {
          ctx.strokeStyle = '#22e58b';
          ctx.lineWidth = 3.2;
          ctx.shadowColor = 'rgba(34, 229, 139, 0.65)';
          ctx.shadowBlur = 9;
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 1.5;
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // 切音标记
    const notes = this.syncFaderNotes(currentBeat, bpm, pattern, 'combo');
    for (const n of notes) {
      const y = this.beatToY(n.beat, currentBeat);
      if (y < -30 || y > H + 30) continue;
      if (n.status === 'pending') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(faderTrackX + 10, y - 9);
        ctx.lineTo(faderTrackX - 7, y);
        ctx.lineTo(faderTrackX + 10, y + 9);
        ctx.stroke();
      } else if (n.status === 'perfect' || n.status === 'good') {
        this.drawCrossMark(ctx, faderTrackX, y, 10, n.status === 'perfect' ? '#22e58b' : '#f5b942', 2.8, 12);
      } else {
        this.drawCrossMark(ctx, faderTrackX, y, 7, 'rgba(255, 77, 109, 0.78)', 2.0, 4);
      }
    }

    // 判定线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(faderTrackX - 30, judgeY);
    ctx.lineTo(centerX + ampX * 1.35, judgeY);
    ctx.stroke();

    // 双光标：左横推指示点 + 右转盘 X
    this.drawCrossMark(ctx, faderTrackX, judgeY, 7, faderOpen ? '#22e58b' : 'rgba(255,255,255,0.45)', 2.2, faderOpen ? 12 : 0);
    this.drawCrossMark(ctx, centerX + platterPos * ampX, judgeY, 9, '#ffffff', 2.4, 12);

    ctx.restore();
  }

  /**
   * Free 自由示波模式（对标 Scratch Visualizer）
   * 左栏：实时转盘 TTM 曲线（开音亮绿/白，关音暗灰）
   * 右栏：实时横推开合波形
   */
  drawFreeMode(ctx, W, H, judgeY, currentBeat, faderRaw, faderOpen, platterPos) {
    const isNarrow = W < 460;
    const platterCenterX = isNarrow ? W * 0.28 : W * 0.36;
    const platterAmp = isNarrow ? W * 0.22 : Math.min(W * 0.18, 140);
    const faderBaseX = isNarrow ? W * 0.60 : W * 0.65;
    const faderAmp = isNarrow ? W * 0.32 : Math.min(W * 0.2, 160);

    ctx.save();

    // 区域标题
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.font = '700 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PLATTER 唱盘轨迹 (TTM)', platterCenterX, 26);
    ctx.fillText('CROSSFADER 横推波形', faderBaseX + faderAmp * 0.5, 26);

    // 基准线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(platterCenterX, 38);
    ctx.lineTo(platterCenterX, H);
    ctx.moveTo(faderBaseX, 38);
    ctx.lineTo(faderBaseX, H);
    ctx.stroke();

    // 历史双轨曲线
    if (this.history.length > 1) {
      // 转盘曲线
      for (let i = this.history.length - 1; i >= 1; i--) {
        const p1 = this.history[i];
        const p0 = this.history[i - 1];
        const y1 = this.beatToY(p1.beat, currentBeat);
        const y0 = this.beatToY(p0.beat, currentBeat);
        if (y1 < judgeY - 2) continue;
        if (y0 > H + 20) break;

        ctx.beginPath();
        ctx.moveTo(platterCenterX + p1.platter * platterAmp, y1);
        ctx.lineTo(platterCenterX + p0.platter * platterAmp, y0);
        ctx.strokeStyle = p1.faderOpen ? '#22e58b' : 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = p1.faderOpen ? 3.0 : 1.5;
        ctx.stroke();
      }

      // 横推波形
      ctx.beginPath();
      let started = false;
      for (let i = this.history.length - 1; i >= 0; i--) {
        const pt = this.history[i];
        const y = this.beatToY(pt.beat, currentBeat);
        if (y < judgeY - 2) continue;
        if (y > H + 20) break;
        const x = faderBaseX + pt.fader * faderAmp;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }

    // 水平判定线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(40, judgeY);
    ctx.lineTo(W - 40, judgeY);
    ctx.stroke();

    // 双实时光标
    this.drawCrossMark(ctx, platterCenterX + platterPos * platterAmp, judgeY, 9, faderOpen ? '#22e58b' : '#ffffff', 2.4, 12);
    this.drawCrossMark(ctx, faderBaseX + faderRaw * faderAmp, judgeY, 9, '#ffffff', 2.4, 12);

    ctx.restore();
  }

  drawCrossMark(ctx, x, y, size, color, lineWidth = 2.5, blur = 10) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    if (blur > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
    }
    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.stroke();
    ctx.restore();
  }

  drawFlashes(ctx, W, judgeY) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      ctx.save();
      ctx.globalAlpha = f.t * 0.35;
      ctx.fillStyle = f.color;
      ctx.fillRect(0, judgeY - 3, W, 6);
      ctx.restore();
      f.t -= 0.08;
      if (f.t <= 0) this.flashes.splice(i, 1);
    }
  }
}
