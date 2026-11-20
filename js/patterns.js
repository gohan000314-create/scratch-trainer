/**
 * 内置 TTM（Turntablist Transcription Methodology）搓盘谱面库
 * 所有时间坐标单位均为「拍（Beat）」，一个循环周期为 loopBeats 拍（通常 4 拍 = 1 小节）。
 *
 * 1. Fader 谱面：faderNotes 数组，每一项为 { beat, type }（在指定拍点触发切音开合）
 * 2. Platter 谱面：platterFn(beatInLoop) 返回 [-1, 1] 之间的标准唱盘位移坐标
 *    （0 为基准起点，正向为前推，负向或回落为后拉）
 */

export const PATTERNS = {
  fader: [
    {
      id: 'fader_transform_8th',
      name: '1/8 Transform Cuts（八分切音）',
      shortTitle: '1/8 Transform Cuts',
      defaultBpm: 95,
      loopBeats: 4,
      subdivision: 2, // 每拍2格（八分音符）
      // 还原视频前半段：规律的八分切音点
      faderNotes: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
      description: '最经典的八分音符横推切音练习，精准还原视频前半段手感。'
    },
    {
      id: 'fader_quarter',
      name: '1/4 Basic Cuts（四分基础切音）',
      shortTitle: '1/4 Basic Cuts',
      defaultBpm: 90,
      loopBeats: 4,
      subdivision: 1,
      faderNotes: [0, 1, 2, 3],
      description: '入门找 Rane One MAG FOUR 横推 Cut-In 切入点的最佳练习。'
    },
    {
      id: 'fader_16th',
      name: '1/16 Rapid Cuts（十六分快切）',
      shortTitle: '1/16 Rapid Cuts',
      defaultBpm: 85,
      loopBeats: 4,
      subdivision: 4,
      faderNotes: [
        0, 0.25, 0.5, 0.75,
        1.0, 1.25, 1.5,
        2.0, 2.25, 2.5, 2.75,
        3.0, 3.5
      ],
      description: '高密度十六分音符 Transform 切音，训练手指爆发力与稳定度。'
    },
    {
      id: 'fader_triplet',
      name: 'Triplet Cuts（三连音切音）',
      shortTitle: 'Triplet Cuts',
      defaultBpm: 92,
      loopBeats: 4,
      subdivision: 3,
      faderNotes: [
        0, 1 / 3, 2 / 3,
        1, 1 + 1 / 3, 1 + 2 / 3,
        2, 2 + 1 / 3, 2 + 2 / 3,
        3, 3.5
      ],
      description: 'Hip-Hop / Boom Bap 常用的三连音律动切音，进阶 Flare 必备。'
    },
    {
      id: 'fader_crab',
      name: 'Double / Crab Rhythm（双击螃蟹节奏）',
      shortTitle: 'Crab Rhythm',
      defaultBpm: 88,
      loopBeats: 4,
      subdivision: 4,
      faderNotes: [
        0, 0.25, 0.5,
        1.0, 1.16, 1.33, 1.5,
        2.0, 2.25, 2.5,
        3.0, 3.16, 3.33, 3.5
      ],
      description: '包含短促密集连切（模拟三指/四指 Crab 节奏型）的横推练习。'
    }
  ],

  platter: [
    {
      id: 'platter_baby_rhythm',
      name: 'Baby Rhythm（视频同款 Baby 律动）',
      shortTitle: 'Baby Rhythm',
      defaultBpm: 100,
      loopBeats: 4,
      subdivision: 2,
      // 还原视频 00:11 的 Baby Rhythm • 100 BPM：
      // 拍 0~1: 单次大波（前推后拉） + 停顿
      // 拍 1~2: 连续两次快速 Baby（1/8 正弦波）
      // 拍 2~3: 停顿缓冲 + 一次中速前推后拉
      // 拍 3~4: 快速三连/双波收尾
      platterFn(b) {
        if (b < 0.75) {
          // 单次饱满 Baby
          return Math.sin((b / 0.75) * Math.PI) * 0.85;
        }
        if (b < 1.0) {
          return 0;
        }
        if (b < 2.0) {
          // 连续两次标准八分 Baby
          const local = (b - 1.0) * 2; // 0..2
          return Math.sin((local % 1) * Math.PI) * 0.78;
        }
        if (b < 2.5) {
          return 0;
        }
        if (b < 3.0) {
          return Math.sin(((b - 2.5) / 0.5) * Math.PI) * 0.85;
        }
        // 3.0..4.0 快速两次回弹
        const tail = (b - 3.0) * 2;
        return Math.sin((tail % 1) * Math.PI) * 0.72;
      },
      description: '1:1 复刻视频后半段（100 BPM）的经典 Baby Scratch 律动组合。'
    },
    {
      id: 'platter_baby_steady',
      name: 'Steady 1/8 Baby（匀速八分 Baby）',
      shortTitle: 'Steady Baby',
      defaultBpm: 95,
      loopBeats: 4,
      subdivision: 2,
      platterFn(b) {
        // 每拍一个完整前推后拉
        return Math.sin((b % 1) * Math.PI) * 0.82;
      },
      description: '最扎实的基本功：保持匀速稳定的正弦波前推后拉。'
    },
    {
      id: 'platter_forward_drag',
      name: 'Forward & Slow Drag（快推慢拉）',
      shortTitle: 'Forward & Drag',
      defaultBpm: 90,
      loopBeats: 4,
      subdivision: 2,
      platterFn(b) {
        const local = b % 2;
        if (local < 0.4) {
          // 快速前推
          return (local / 0.4) * 0.9;
        }
        if (local < 1.6) {
          // 慢速匀速回拉
          return 0.9 * (1 - (local - 0.4) / 1.2);
        }
        return 0;
      },
      description: '训练快推（Release/Push）与慢速控制回拉的肌肉记忆。'
    },
    {
      id: 'platter_tear',
      name: 'Tear Scratch（一推二拉 Tear）',
      shortTitle: 'Tear Pattern',
      defaultBpm: 92,
      loopBeats: 4,
      subdivision: 4,
      platterFn(b) {
        const local = b % 2;
        if (local < 0.5) {
          // 一推到底
          return (local / 0.5) * 0.9;
        }
        if (local < 0.85) {
          // 第一段回拉到一半
          return 0.9 - ((local - 0.5) / 0.35) * 0.45;
        }
        if (local < 1.15) {
          // 中间短暂停顿（Tear 灵魂）
          return 0.45;
        }
        if (local < 1.6) {
          // 第二段回拉归零
          return 0.45 * (1 - (local - 1.15) / 0.45);
        }
        return 0;
      },
      description: '不用横推就能切出三段音的经典 Tear 轨迹（前推 -> 拉半程停顿 -> 拉回起点）。'
    }
  ],

  combo: [
    {
      id: 'combo_chirp',
      name: 'Chirp（经典小鸟搓）',
      shortTitle: 'Chirp',
      defaultBpm: 90,
      loopBeats: 4,
      subdivision: 2,
      // 推到顶瞬间关横推（下降沿判定），拉回起点重新开横推
      faderCutEdge: 'close',
      faderNotes: [0.5, 1.5, 2.5, 3.5],
      platterFn(b) {
        const local = b % 1;
        return local < 0.5 ? (local / 0.5) * 0.85 : ((1 - local) / 0.5) * 0.85;
      },
      description: '手推到顶瞬间关横推、回拉起点开横推的经典协调招式（判定关音切点）。'
    },
    {
      id: 'combo_1click_flare',
      name: '1-Click Flare（一击火焰搓）',
      shortTitle: '1-Click Flare',
      defaultBpm: 88,
      loopBeats: 4,
      subdivision: 2,
      // 横推常开，在前推中途与回拉中途各瞬关一次切音（下降沿判定）
      faderCutEdge: 'close',
      faderNotes: [0.5, 1.5, 2.5, 3.5],
      platterFn(b) {
        const local = b % 2;
        return local < 1 ? local * 0.88 : (2 - local) * 0.88;
      },
      description: '横推常开，在前推与回拉的中段各轻点瞬关一次切音（判定关音切点）。'
    },
    {
      id: 'combo_transformer',
      name: 'Transformer（变形金刚搓）',
      shortTitle: 'Transformer',
      defaultBpm: 92,
      loopBeats: 4,
      subdivision: 4,
      faderNotes: [0, 0.25, 0.5, 0.75, 1.5, 2.0, 2.25, 2.5, 2.75, 3.5],
      platterFn(b) {
        const local = b % 2;
        if (local < 1.0) return local * 0.9;
        return (2.0 - local) * 0.9;
      },
      description: '慢推唱盘同时用横推快速点击切出多个颗粒音。'
    }
  ],

  free: [
    {
      id: 'free_scope',
      name: 'Free Visualizer（自由实时示波）',
      shortTitle: 'Free Scope',
      defaultBpm: 95,
      loopBeats: 4,
      subdivision: 2,
      faderNotes: [],
      platterFn: null,
      description: '无固定谱面限制，实时绘制你的横推与唱盘 TTM 曲线，类似 Scratch Visualizer。'
    }
  ]
};
