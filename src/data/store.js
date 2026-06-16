'use strict';

/**
 * 数据访问收口层。
 * - 所有业务 CRUD + 群体变更事件的创建与查询；
 * - 谱系追溯、守恒核算、异常检测、状态重建 委托给 ./lineage（纯函数）。
 */

const { getDb } = require('../db');
const { hashPassword } = require('../utils/password');
const lineage = require('./lineage');

/* ------------------------------------------------------------------ */
/*  工具：行转对象、字段名 snake_case → camelCase 转换              */
/* ------------------------------------------------------------------ */

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function _snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelize(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(camelize);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    out[_snakeToCamel(k)] = obj[k];
  }
  return out;
}

function mapUser(row) {
  if (!row) return null;
  const { passwordHash, ...rest } = camelize(row);
  void passwordHash;
  return rest;
}

function getUserWithPassword(username) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return row ? camelize(row) : null;
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

function countUsers() {
  const conn = getDb();
  return conn.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function listUsers() {
  const conn = getDb();
  return conn.prepare('SELECT * FROM users ORDER BY id').all().map(mapUser);
}

function getUserById(id) {
  const conn = getDb();
  return mapUser(conn.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function getUserByUsername(username) {
  const conn = getDb();
  return mapUser(conn.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function getUserWithPassword(username) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function createUser({ username, password, name, role = 'viewer', active = true }) {
  const conn = getDb();
  const info = conn.prepare(`
    INSERT INTO users (username, password_hash, name, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(username, hashPassword(password), name, role, active ? 1 : 0, now(), now());
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, patch) {
  const conn = getDb();
  const allowed = ['name', 'role', 'active', 'password'];
  const sets = [];
  const args = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (k === 'password') {
      sets.push('password_hash = ?');
      args.push(hashPassword(patch.password));
    } else if (k === 'active') {
      sets.push('active = ?');
      args.push(patch.active ? 1 : 0);
    } else {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return getUserById(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  conn.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getUserById(id);
}

function deleteUser(id) {
  const conn = getDb();
  conn.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ */
/*  Apiaries                                                           */
/* ------------------------------------------------------------------ */

function listApiaries({ district, status, keyword } = {}) {
  const conn = getDb();
  const where = [];
  const args = [];
  if (district) { where.push('district = ?'); args.push(district); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (keyword) {
    where.push('(name LIKE ? OR code LIKE ? OR location LIKE ?)');
    const k = `%${keyword}%`;
    args.push(k, k, k);
  }
  const sql = `SELECT * FROM apiaries${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  return camelize(conn.prepare(sql).all(...args));
}

function getApiaryById(id) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM apiaries WHERE id = ?').get(id));
}

function getApiaryByCode(code) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM apiaries WHERE code = ?').get(code));
}

function createApiary({ code, name, location, district, keeper, status = 'active' }) {
  const conn = getDb();
  const info = conn.prepare(`
    INSERT INTO apiaries (code, name, location, district, keeper, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, name, location, district, keeper || null, status, now(), now());
  return getApiaryById(info.lastInsertRowid);
}

function updateApiary(id, patch) {
  const conn = getDb();
  const allowed = ['code', 'name', 'location', 'district', 'keeper', 'status'];
  const sets = [];
  const args = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(patch[k]);
  }
  if (!sets.length) return getApiaryById(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  conn.prepare(`UPDATE apiaries SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getApiaryById(id);
}

function deleteApiary(id) {
  const conn = getDb();
  conn.prepare('DELETE FROM apiaries WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ */
/*  Hives                                                              */
/* ------------------------------------------------------------------ */

function listHives({ apiaryId, status, keyword } = {}) {
  const conn = getDb();
  const where = [];
  const args = [];
  if (apiaryId !== undefined) { where.push('apiary_id = ?'); args.push(Number(apiaryId)); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (keyword) {
    where.push('code LIKE ?');
    args.push(`%${keyword}%`);
  }
  const sql = `SELECT * FROM hives${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  return camelize(conn.prepare(sql).all(...args));
}

function getHiveById(id) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM hives WHERE id = ?').get(id));
}

function getHiveByCode(code) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM hives WHERE code = ?').get(code));
}

function createHive({ code, apiaryId, queenYear, frameCount = 0, strength = 'medium', status = 'active', installedAt = null }) {
  const conn = getDb();
  const info = conn.prepare(`
    INSERT INTO hives (code, apiary_id, queen_year, frame_count, strength, status, installed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, Number(apiaryId), queenYear || null, Number(frameCount), strength, status, installedAt, now(), now());
  return getHiveById(info.lastInsertRowid);
}

function updateHive(id, patch) {
  const conn = getDb();
  const allowed = ['code', 'apiaryId', 'queenYear', 'frameCount', 'strength', 'status', 'installedAt'];
  const colMap = { apiaryId: 'apiary_id', queenYear: 'queen_year', frameCount: 'frame_count', installedAt: 'installed_at' };
  const sets = [];
  const args = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    const col = colMap[k] || k;
    sets.push(`${col} = ?`);
    args.push(k === 'frameCount' || k === 'apiaryId' ? Number(patch[k]) : patch[k]);
  }
  if (!sets.length) return getHiveById(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  conn.prepare(`UPDATE hives SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getHiveById(id);
}

function deleteHive(id) {
  const conn = getDb();
  conn.prepare('DELETE FROM hives WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ */
/*  Inspections                                                        */
/* ------------------------------------------------------------------ */

function listInspections({ hiveId } = {}) {
  const conn = getDb();
  let sql = 'SELECT * FROM inspections';
  const args = [];
  if (hiveId !== undefined) { sql += ' WHERE hive_id = ?'; args.push(Number(hiveId)); }
  sql += ' ORDER BY inspect_date DESC, id DESC';
  return camelize(conn.prepare(sql).all(...args));
}

function createInspection({ hiveId, inspectorId, inspectDate, hasQueen = true, broodFrames = 0, honeyFrames = 0, disease = 'none', note = null }) {
  const conn = getDb();
  const info = conn.prepare(`
    INSERT INTO inspections (hive_id, inspector_id, inspect_date, has_queen, brood_frames, honey_frames, disease, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(hiveId), inspectorId || null, inspectDate, hasQueen ? 1 : 0, Number(broodFrames), Number(honeyFrames), disease, note, now());
  return camelize(conn.prepare('SELECT * FROM inspections WHERE id = ?').get(info.lastInsertRowid));
}

/* ------------------------------------------------------------------ */
/*  Harvests                                                           */
/* ------------------------------------------------------------------ */

function listHarvests({ apiaryId, product } = {}) {
  const conn = getDb();
  const where = [];
  const args = [];
  if (apiaryId !== undefined) { where.push('apiary_id = ?'); args.push(Number(apiaryId)); }
  if (product) { where.push('product = ?'); args.push(product); }
  const sql = `SELECT * FROM harvests${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY harvest_date DESC, id DESC`;
  return camelize(conn.prepare(sql).all(...args));
}

function getHarvestByBatchNo(batchNo) {
  const conn = getDb();
  return camelize(conn.prepare('SELECT * FROM harvests WHERE batch_no = ?').get(batchNo));
}

function createHarvest({ batchNo, apiaryId, harvestDate, product = 'honey', quantityKg = 0, note = null }) {
  const conn = getDb();
  const info = conn.prepare(`
    INSERT INTO harvests (batch_no, apiary_id, harvest_date, product, quantity_kg, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(batchNo, Number(apiaryId), harvestDate, product, Number(quantityKg), note, now());
  return camelize(conn.prepare('SELECT * FROM harvests WHERE id = ?').get(info.lastInsertRowid));
}

/* ================================================================== */
/*  群体变更事件（核心收口）                                           */
/* ================================================================== */

const EVENT_TYPES = lineage.EVENT_TYPES;

function _rowToEvent(row) {
  if (!row) return null;
  return camelize(row);
}

function _rowToRelation(row) {
  if (!row) return null;
  return camelize(row);
}

/* ---- 基础 CRUD --------------------------------------------------- */

function listColonyEvents({ eventType, apiaryId, hiveId, fromDate, toDate } = {}) {
  const conn = getDb();
  let sql = `
    SELECT DISTINCT e.* FROM colony_events e
    LEFT JOIN event_hive_relations r ON r.event_id = e.id
    WHERE 1=1
  `;
  const args = [];
  if (eventType) { sql += ' AND e.event_type = ?'; args.push(eventType); }
  if (apiaryId !== undefined) { sql += ' AND e.apiary_id = ?'; args.push(Number(apiaryId)); }
  if (hiveId !== undefined) { sql += ' AND r.hive_id = ?'; args.push(Number(hiveId)); }
  if (fromDate) { sql += ' AND e.event_date >= ?'; args.push(fromDate); }
  if (toDate) { sql += ' AND e.event_date <= ?'; args.push(toDate); }
  sql += ' ORDER BY e.event_date ASC, e.id ASC';
  return conn.prepare(sql).all(...args).map(_rowToEvent);
}

function getColonyEventById(id) {
  const conn = getDb();
  return _rowToEvent(conn.prepare('SELECT * FROM colony_events WHERE id = ?').get(id));
}

function getRelationsByEventId(eventId) {
  const conn = getDb();
  return conn.prepare('SELECT * FROM event_hive_relations WHERE event_id = ? ORDER BY id').all(eventId).map(_rowToRelation);
}

function getRelationsByHiveId(hiveId) {
  const conn = getDb();
  return conn.prepare('SELECT * FROM event_hive_relations WHERE hive_id = ? ORDER BY id').all(hiveId).map(_rowToRelation);
}

function _getAllEvents() {
  const conn = getDb();
  return conn.prepare('SELECT * FROM colony_events ORDER BY event_date, id').all().map(_rowToEvent);
}
function _getAllRelations() {
  const conn = getDb();
  return conn.prepare('SELECT * FROM event_hive_relations ORDER BY id').all().map(_rowToRelation);
}
function _getAllHives() {
  return listHives();
}

/* ---- 创建事件（带事务 + 校验 + 同步 hive 快照） ----------------- */

/**
 * 创建一条群体变更事件。
 *
 * payload:
 *   eventType: EVENT_TYPES.*
 *   eventDate: YYYY-MM-DD
 *   operatorId?: number
 *   apiaryId?: number
 *   note?: string
 *   frameDiff?: number
 *   frameDiffNote?: string
 *   sources: [{ hiveId, frameCount?, strength?, framesMoved? }]    // 参与事件的源群
 *   targets: [{ hiveId, frameCount?, strength?, framesMoved? }]    // 事件产出的目标群
 *   skipAnomalyCheck?: boolean  // 仅测试用
 *   applyHiveSnapshot?: boolean // 默认 true：是否同步更新 hives 表的 frame_count/status 快照
 *
 * 校验流程：
 *   1. 基本结构校验（参数完整性）
 *   2. 先按"加入新事件后的全集"跑 detectAnomalies，若有 error 级异常则拒绝；warn 会收集但不阻塞
 *   3. 在同一事务内写 colony_events + event_hive_relations + 可选 hives 同步
 */
function createColonyEvent(payload) {
  const conn = getDb();
  const {
    eventType, eventDate, operatorId = null, apiaryId = null, note = null,
    frameDiff = 0, frameDiffNote = null,
    sources = [], targets = [],
    skipAnomalyCheck = false, applyHiveSnapshot = true,
  } = payload || {};

  if (!lineage.validEventType(eventType)) {
    const e = new Error(`非法的事件类型：${eventType}`); e.statusCode = 400; throw e;
  }
  if (!eventDate) { const e = new Error('eventDate 不能为空'); e.statusCode = 400; throw e; }
  if (!Array.isArray(sources) || !Array.isArray(targets)) {
    const e = new Error('sources / targets 必须是数组'); e.statusCode = 400; throw e;
  }
  for (const s of sources) {
    if (!s || !s.hiveId) { const e = new Error('source 缺少 hiveId'); e.statusCode = 400; throw e; }
    if (!getHiveById(Number(s.hiveId))) { const e = new Error(`source hive #${s.hiveId} 不存在`); e.statusCode = 404; throw e; }
  }
  for (const t of targets) {
    if (!t || !t.hiveId) { const e = new Error('target 缺少 hiveId'); e.statusCode = 400; throw e; }
    if (!getHiveById(Number(t.hiveId))) { const e = new Error(`target hive #${t.hiveId} 不存在`); e.statusCode = 404; throw e; }
  }

  const sourceHiveIds = sources.map((s) => Number(s.hiveId));
  const targetHiveIds = targets.map((t) => Number(t.hiveId));
  if (new Set(sourceHiveIds).size !== sourceHiveIds.length) {
    const e = new Error('sources 存在重复 hiveId'); e.statusCode = 400; throw e;
  }
  if (new Set(targetHiveIds).size !== targetHiveIds.length) {
    const e = new Error('targets 存在重复 hiveId'); e.statusCode = 400; throw e;
  }
  // 非 MERGE 事件：严格禁止同群同时出现在两边
  if (eventType !== EVENT_TYPES.MERGE && sourceHiveIds.some((id) => targetHiveIds.includes(id))) {
    const e = new Error('同一群不能同时出现在 sources 和 targets'); e.statusCode = 400; throw e;
  }
  // MERGE 事件：允许 target 在 sources 中出现一次（表示"该群为接收群"），但额外 target（不在 sources 中的新群）不能与 sources 重叠
  if (eventType === EVENT_TYPES.MERGE) {
    const sourcesSet = new Set(sourceHiveIds);
    const extraTargets = targetHiveIds.filter((id) => !sourcesSet.has(id));
    if (extraTargets.length > 0) {
      const e = new Error('合并事件的 target 必须为接收群之一（应出现在 sources 中），新增群不合法'); e.statusCode = 400; throw e;
    }
    if (targetHiveIds.length !== 1) {
      const e = new Error('合并事件必须且只能有 1 个接收群（target）'); e.statusCode = 400; throw e;
    }
  }

  const insertEventStmt = conn.prepare(`
    INSERT INTO colony_events (event_type, event_date, operator_id, apiary_id, note, frame_diff, frame_diff_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRelStmt = conn.prepare(`
    INSERT INTO event_hive_relations (event_id, hive_id, role, frame_count, strength, frames_moved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // ====================================================================
  // 第一阶段：预检 —— 构造 mock 事件 + mock 关系，用 detectAnomalies 跑一遍
  // 如果有 error 级异常，直接抛错，**不进入任何写操作**，hives 表完全不受影响
  // ====================================================================
  if (!skipAnomalyCheck) {
    try {
      const existingEvents = _getAllEvents();
      const existingRels = _getAllRelations();
      const MOCK_ID = Number.MAX_SAFE_INTEGER;
      const createdAt = now();

      const mockEvent = {
        id: MOCK_ID,
        eventType,
        eventDate,
        operatorId: operatorId || null,
        apiaryId: apiaryId || null,
        note: note || null,
        frameDiff: Number(frameDiff) || 0,
        frameDiffNote: frameDiffNote || null,
        createdAt,
      };

      const mockRels = [];
      for (const s of sources) {
        const h = getHiveById(Number(s.hiveId));
        mockRels.push({
          id: MOCK_ID,
          eventId: MOCK_ID,
          hiveId: Number(s.hiveId),
          role: 'source',
          frameCount: s.frameCount != null ? Number(s.frameCount) : (h ? h.frameCount : null),
          strength: s.strength || (h ? h.strength : null),
          framesMoved: s.framesMoved != null ? Number(s.framesMoved) : null,
          createdAt,
        });
      }
      for (const t of targets) {
        const h = getHiveById(Number(t.hiveId));
        mockRels.push({
          id: MOCK_ID,
          eventId: MOCK_ID,
          hiveId: Number(t.hiveId),
          role: 'target',
          frameCount: t.frameCount != null ? Number(t.frameCount) : (h ? h.frameCount : null),
          strength: t.strength || (h ? h.strength : null),
          framesMoved: t.framesMoved != null ? Number(t.framesMoved) : null,
          createdAt,
        });
      }

      const allEvents = existingEvents.concat([mockEvent]);
      const allRels = existingRels.concat(mockRels);
      const anomalies = lineage.detectAnomalies(allEvents, allRels);
      const relatedIds = new Set([MOCK_ID, ...sourceHiveIds, ...targetHiveIds]);
      const blocking = anomalies.filter((a) =>
        a.severity === 'error' &&
        (a.eventId === MOCK_ID || (a.hiveIds || []).some((h) => relatedIds.has(h)))
      );
      if (blocking.length) {
        const msgs = blocking.map((a) => `[${a.type}] ${a.message}`).join('；');
        const e = new Error(`事件校验失败，拒绝写入：${msgs}`);
        e.statusCode = 422;
        e.anomalies = blocking;
        throw e;
      }
    } catch (detectErr) {
      if (detectErr.statusCode) throw detectErr;
      const e = new Error(`事件校验内部错误：${detectErr.message}`);
      e.statusCode = 500;
      throw e;
    }
  }

  // ====================================================================
  // 第二阶段：正式写入 —— 预检通过，事务内真正 INSERT + hives 快照 UPDATE
  // （事务内抛异常会自动 ROLLBACK，hives 快照不受影响）
  // ====================================================================
  const runTx = conn.transaction(() => {
    const eventInfo = insertEventStmt.run(
      eventType, eventDate, operatorId || null, apiaryId || null, note,
      Number(frameDiff) || 0, frameDiffNote || null, now()
    );
    const eventId = Number(eventInfo.lastInsertRowid);

    for (const s of sources) {
      const h = getHiveById(Number(s.hiveId));
      insertRelStmt.run(
        eventId, Number(s.hiveId), 'source',
        s.frameCount != null ? Number(s.frameCount) : (h ? h.frameCount : null),
        s.strength || (h ? h.strength : null),
        s.framesMoved != null ? Number(s.framesMoved) : null,
        now()
      );
    }
    for (const t of targets) {
      const h = getHiveById(Number(t.hiveId));
      insertRelStmt.run(
        eventId, Number(t.hiveId), 'target',
        t.frameCount != null ? Number(t.frameCount) : (h ? h.frameCount : null),
        t.strength || (h ? h.strength : null),
        t.framesMoved != null ? Number(t.framesMoved) : null,
        now()
      );
    }

    if (applyHiveSnapshot) _applyEventHiveSnapshot(
      eventType, sources, targets
    );

    return eventId;
  });

  let eventId;
  try {
    eventId = runTx();
  } catch (err) {
    if (!err.statusCode) err.statusCode = 500;
    throw err;
  }

  return getColonyEventDetail(eventId);
}

/**
 * 根据事件类型同步更新 hives 表的快照：frame_count / status。
 * 只在事件创建时调用一次（同事务）。
 */
function _applyEventHiveSnapshot(eventType, sources, targets) {
  const updateStmt = getDb().prepare(
    'UPDATE hives SET frame_count = ?, strength = ?, status = ?, updated_at = ? WHERE id = ?'
  );

  if (eventType === EVENT_TYPES.NATURAL_SWARM || eventType === EVENT_TYPES.ARTIFICIAL_SPLIT) {
    const mother = sources[0];
    if (mother) {
      let moved = 0;
      for (const t of targets) moved += Number(t.framesMoved) || 0;
      const motherHive = getHiveById(Number(mother.hiveId));
      const remain = Math.max(0, (mother.frameCount != null ? Number(mother.frameCount) : (motherHive ? motherHive.frameCount : 0)) - moved);
      updateStmt.run(remain, mother.strength || (motherHive ? motherHive.strength : 'medium'), 'active', now(), Number(mother.hiveId));
    }
    for (const t of targets) {
      const h = getHiveById(Number(t.hiveId));
      const fc = t.frameCount != null ? Number(t.frameCount) : (Number(t.framesMoved) || (h ? h.frameCount : 0));
      updateStmt.run(fc, t.strength || (h ? h.strength : 'medium'), 'active', now(), Number(t.hiveId));
    }
  } else if (eventType === EVENT_TYPES.MERGE || eventType === EVENT_TYPES.MERGED_OUT) {
    for (const s of sources) {
      const h = getHiveById(Number(s.hiveId));
      updateStmt.run(h ? h.frameCount : 0, h ? h.strength : 'medium', eventType === EVENT_TYPES.MERGE ? 'merged_inactive' : 'merged_out', now(), Number(s.hiveId));
    }
    for (const t of targets) {
      const total = sources.reduce((sum, s) => sum + (Number(s.frameCount) || 0), 0);
      const h = getHiveById(Number(t.hiveId));
      updateStmt.run(t.frameCount != null ? Number(t.frameCount) : total, t.strength || (h ? h.strength : 'medium'), 'active', now(), Number(t.hiveId));
    }
  } else if (eventType === EVENT_TYPES.REHOUSE) {
    const s = sources[0];
    const t = targets[0];
    if (s) {
      const h = getHiveById(Number(s.hiveId));
      updateStmt.run(h ? h.frameCount : 0, h ? h.strength : 'medium', 'rehoused_out', now(), Number(s.hiveId));
    }
    if (t) {
      const h = getHiveById(Number(t.hiveId));
      const fc = t.frameCount != null ? Number(t.frameCount) : (s ? Number(s.frameCount) || (h ? h.frameCount : 0) : (h ? h.frameCount : 0));
      updateStmt.run(fc, t.strength || (h ? h.strength : 'medium'), 'active', now(), Number(t.hiveId));
    }
  } else if (eventType === EVENT_TYPES.NATURAL_DEATH) {
    for (const s of sources) {
      const h = getHiveById(Number(s.hiveId));
      updateStmt.run(h ? h.frameCount : 0, h ? h.strength : 'weak', 'dead', now(), Number(s.hiveId));
    }
  }
}

function getColonyEventDetail(id) {
  const ev = getColonyEventById(id);
  if (!ev) return null;
  const rels = getRelationsByEventId(id);
  const sources = rels.filter((r) => r.role === 'source');
  const targets = rels.filter((r) => r.role === 'target');
  const conservation = lineage.computeEventConservation(ev, rels);
  return { ...ev, relations: rels, sources, targets, conservation };
}

function deleteColonyEvent(id) {
  const conn = getDb();
  conn.prepare('DELETE FROM event_hive_relations WHERE event_id = ?').run(id);
  conn.prepare('DELETE FROM colony_events WHERE id = ?').run(id);
}

/* ---- 谱系追溯接口 ----------------------------------------------- */

function getHiveLineage(hiveId) {
  const all = _getAllEvents();
  const rels = _getAllRelations();
  const core = lineage.traceLineage(Number(hiveId), all, rels);
  const ancestors = lineage.traceAncestors(Number(hiveId), all, rels);
  const descendants = lineage.traceDescendants(Number(hiveId), all, rels);
  return { ...core, ancestors, descendants };
}

function getHiveAncestors(hiveId) {
  return lineage.traceAncestors(Number(hiveId), _getAllEvents(), _getAllRelations());
}
function getHiveDescendants(hiveId) {
  return lineage.traceDescendants(Number(hiveId), _getAllEvents(), _getAllRelations());
}

/* ---- 守恒核算 & 异常检测 ---------------------------------------- */

function getEventConservation(eventId) {
  const ev = getColonyEventById(eventId);
  if (!ev) return null;
  return lineage.computeEventConservation(ev, getRelationsByEventId(eventId));
}

function getAllConservation() {
  return lineage.computeAllConservation(_getAllEvents(), _getAllRelations());
}

function getAnomalies() {
  return lineage.detectAnomalies(_getAllEvents(), _getAllRelations());
}

/* ---- 任意时点状态重建 ------------------------------------------- */

function getStateAt(pointInTime) {
  const stateMap = lineage.reconstructStateAt(pointInTime, _getAllEvents(), _getAllRelations(), _getAllHives());
  const out = {};
  for (const [k, v] of stateMap.entries()) out[k] = v;
  return { pointInTime, byHiveId: out };
}

function getAliveSummaryAt(pointInTime) {
  return lineage.summarizeAliveAt(pointInTime, _getAllEvents(), _getAllRelations(), _getAllHives());
}

/* ------------------------------------------------------------------ */
/*  导出                                                               */
/* ------------------------------------------------------------------ */

module.exports = {
  // Users
  countUsers, listUsers, getUserById, getUserByUsername, getUserWithPassword,
  createUser, updateUser, deleteUser, mapUser,

  // Apiaries
  listApiaries, getApiaryById, getApiaryByCode, createApiary, updateApiary, deleteApiary,

  // Hives
  listHives, getHiveById, getHiveByCode, createHive, updateHive, deleteHive,

  // Inspections
  listInspections, createInspection,

  // Harvests
  listHarvests, getHarvestByBatchNo, createHarvest,

  // Colony events (核心)
  EVENT_TYPES,
  listColonyEvents,
  getColonyEventById,
  getColonyEventDetail,
  getRelationsByEventId,
  getRelationsByHiveId,
  createColonyEvent,
  deleteColonyEvent,

  // Lineage queries
  getHiveLineage,
  getHiveAncestors,
  getHiveDescendants,

  // Conservation & anomalies
  getEventConservation,
  getAllConservation,
  getAnomalies,

  // State reconstruction
  getStateAt,
  getAliveSummaryAt,
};
