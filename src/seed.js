'use strict';

const store = require('./data/store');
const ET = store.EVENT_TYPES;

/**
 * 写入初始种子数据：管理员 / 养蜂员 / 观察员各一个账号，
 * 外加若干蜂场、蜂箱、检查记录与采收批次，方便本地起步与「功能迭代」类任务直接有数据可用。
 * 幂等：若库中已存在用户则跳过，避免重复播种。
 */
function seed() {
  if (store.countUsers() > 0) {
    return { skipped: true };
  }

  store.createUser({ username: 'admin', password: 'admin123', name: '系统管理员', role: 'admin' });
  const keeper = store.createUser({ username: 'keeper', password: 'keeper123', name: '王养蜂', role: 'operator' });
  store.createUser({ username: 'viewer', password: 'viewer123', name: '李观察', role: 'viewer' });

  const a1 = store.createApiary({
    code: 'FC-ABA-001', name: '阿坝高山中蜂场', location: '阿坝州黑水县色尔古寨',
    district: '阿坝州', keeper: '王养蜂', status: 'active',
  });
  const a2 = store.createApiary({
    code: 'FC-YA-002', name: '雅安林下中蜂场', location: '雅安市宝兴县蜂桶寨',
    district: '雅安市', keeper: '赵蜂农', status: 'active',
  });
  store.createApiary({
    code: 'FC-LS-003', name: '凉山转场越冬点', location: '凉山州西昌邛海边',
    district: '凉山州', keeper: '王养蜂', status: 'dormant',
  });

  const baseHives = [
    { code: 'XF-001', apiaryId: a1.id, queenYear: 2025, frameCount: 6, strength: 'strong', status: 'active', installedAt: '2025-04-10' },
    { code: 'XF-002', apiaryId: a1.id, queenYear: 2024, frameCount: 4, strength: 'medium', status: 'active', installedAt: '2024-05-01' },
    { code: 'XF-003', apiaryId: a1.id, queenYear: 2025, frameCount: 2, strength: 'weak', status: 'queenless', installedAt: '2025-06-20' },
    { code: 'YA-001', apiaryId: a2.id, queenYear: 2025, frameCount: 7, strength: 'strong', status: 'active', installedAt: '2025-03-15' },
    { code: 'YA-002', apiaryId: a2.id, queenYear: 2024, frameCount: 5, strength: 'medium', status: 'active', installedAt: '2024-04-22' },
  ];
  const baseHiveRecs = baseHives.map((h) => store.createHive(h));

  /* ---------- 演示用：谱系相关新蜂箱（放到凉山 a3 越冬点，避免影响阿坝 a1 的 3 个数量测试） -------- */
  const a3 = store.getApiaryByCode('FC-LS-003');
  const demoHives = [
    { code: 'XF-004', apiaryId: a3.id, queenYear: 2026, frameCount: 2, strength: 'medium', status: 'active', installedAt: '2026-04-12' }, // XF-001 自然分蜂分出，转场凉山
    { code: 'XF-005', apiaryId: a3.id, queenYear: 2026, frameCount: 2, strength: 'weak',   status: 'active', installedAt: '2026-04-28' }, // XF-002 人工分群，转场凉山
    { code: 'YA-003', apiaryId: a2.id, queenYear: 2024, frameCount: 5, strength: 'medium', status: 'active', installedAt: '2026-05-10' }, // YA-002 过箱新箱（雅安内部，不影响阿坝）
    { code: 'XF-006', apiaryId: a3.id, queenYear: 2026, frameCount: 0, strength: 'weak',   status: 'active', installedAt: '2026-05-22' }, // 占位备用
  ];
  const demoHiveRecs = demoHives.map((h) => store.createHive(h));
  const allHiveRecs = [...baseHiveRecs, ...demoHiveRecs];

  function hiveByCode(code) { return allHiveRecs.find((h) => h.code === code); }

  store.createInspection({
    hiveId: hiveByCode('XF-001').id, inspectorId: keeper.id, inspectDate: '2026-05-18',
    hasQueen: true, broodFrames: 3.5, honeyFrames: 2, disease: 'none', note: '群势旺，已加继箱',
  });
  store.createInspection({
    hiveId: hiveByCode('XF-003').id, inspectorId: keeper.id, inspectDate: '2026-05-18',
    hasQueen: false, broodFrames: 0, honeyFrames: 1, disease: 'none', note: '失王，需诱入新王或合并',
  });
  store.createInspection({
    hiveId: hiveByCode('YA-001').id, inspectorId: keeper.id, inspectDate: '2026-05-20',
    hasQueen: true, broodFrames: 4, honeyFrames: 3, disease: 'varroa', note: '发现少量蜂螨，已挂螨扑',
  });

  store.createHarvest({
    batchNo: 'HV-2026-0001', apiaryId: a1.id, harvestDate: '2026-05-25',
    product: 'honey', quantityKg: 28.5, note: '高山百花蜜，波美度合格',
  });
  store.createHarvest({
    batchNo: 'HV-2026-0002', apiaryId: a2.id, harvestDate: '2026-05-28',
    product: 'royal_jelly', quantityKg: 1.2, note: '蜂王浆，冷链暂存',
  });

  /* ---------- 演示用：群体变更事件（合法数据，用于追溯） ---------- */

  // 事件1：XF-001（6脾）自然分蜂，分出 XF-004（带走 2 脾），XF-001 剩 4 脾
  store.createColonyEvent({
    eventType: ET.NATURAL_SWARM,
    eventDate: '2026-04-12',
    operatorId: keeper.id,
    apiaryId: a1.id,
    note: '春末分蜂热，老王带 2 脾分出到新箱 XF-004',
    frameDiff: 0,
    sources: [{ hiveId: hiveByCode('XF-001').id, frameCount: 6, strength: 'strong' }],
    targets: [{ hiveId: hiveByCode('XF-004').id, frameCount: 2, strength: 'medium', framesMoved: 2 }],
  });

  // 事件2：XF-002（4脾）人工育王分群，提 1.5 脾育王组成 XF-005
  store.createColonyEvent({
    eventType: ET.ARTIFICIAL_SPLIT,
    eventDate: '2026-04-28',
    operatorId: keeper.id,
    apiaryId: a1.id,
    note: '人工移虫育王，提 1 框封盖子 + 半框蜜粉组成交尾群 XF-005',
    frameDiff: 0.5,
    frameDiffNote: '提子时带了半框蜜脾上的幼蜂，XF-002 实际略少于 2.5 脾',
    sources: [{ hiveId: hiveByCode('XF-002').id, frameCount: 4, strength: 'medium' }],
    targets: [{ hiveId: hiveByCode('XF-005').id, frameCount: 2, strength: 'weak', framesMoved: 2 }],
  });

  // 事件3：YA-002（5脾）过箱到 YA-003（旧箱有巢虫，换消毒箱）
  store.createColonyEvent({
    eventType: ET.REHOUSE,
    eventDate: '2026-05-10',
    operatorId: keeper.id,
    apiaryId: a2.id,
    note: '旧箱发现蜡螟幼虫，全群连脾带蜂过入消毒箱 YA-003，脾数不变',
    frameDiff: 0,
    sources: [{ hiveId: hiveByCode('YA-002').id, frameCount: 5, strength: 'medium' }],
    targets: [{ hiveId: hiveByCode('YA-003').id, frameCount: 5, strength: 'medium' }],
  });

  // 事件4：XF-003（失王，2脾）合并入 XF-001（分后剩 4 脾），XF-001 应有 6 脾
  store.createColonyEvent({
    eventType: ET.MERGE,
    eventDate: '2026-05-22',
    operatorId: keeper.id,
    apiaryId: a1.id,
    note: 'XF-003 失王半月，无合适新王，喷蜜水间接合并入 XF-001，合群后约 6 脾',
    frameDiff: 0,
    sources: [
      { hiveId: hiveByCode('XF-003').id, frameCount: 2, strength: 'weak' },
      { hiveId: hiveByCode('XF-001').id, frameCount: 4, strength: 'strong' },
    ],
    targets: [{ hiveId: hiveByCode('XF-001').id, frameCount: 6, strength: 'strong' }],
  });

  return {
    skipped: false,
    users: 3,
    apiaries: 3,
    hives: allHiveRecs.length,
    inspections: 3,
    harvests: 2,
    colonyEvents: 4,
  };
}

if (require.main === module) {
  const { getDb, close } = require('./db');
  getDb();
  const result = seed();
  // eslint-disable-next-line no-console
  console.log('种子数据写入结果:', JSON.stringify(result, null, 2));
  close();
}

module.exports = { seed };
