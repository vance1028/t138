'use strict';

/**
 * 蜂群谱系与守恒核算模块（纯函数，不直接访问数据库）。
 *
 * 输入约定（字段名统一 camelCase）：
 *   events    = [{ id, eventType, eventDate, operatorId, apiaryId, note, frameDiff, frameDiffNote, createdAt }, ...]
 *   relations = [{ id, eventId, hiveId, role, frameCount, strength, framesMoved, createdAt }, ...]
 *   hives     = [{ id, code, apiaryId, queenYear, frameCount, strength, status, installedAt, ... }, ...]
 *
 * 所有函数都只依赖入参，不产生副作用，便于单测与复用。
 */

const EVENT_TYPES = Object.freeze({
  NATURAL_SWARM: 'natural_swarm',
  ARTIFICIAL_SPLIT: 'artificial_split',
  MERGE: 'merge',
  REHOUSE: 'rehouse',
  NATURAL_DEATH: 'natural_death',
  MERGED_OUT: 'merged_out',
});

const EVENT_TYPE_LABELS = Object.freeze({
  [EVENT_TYPES.NATURAL_SWARM]: '自然分蜂',
  [EVENT_TYPES.ARTIFICIAL_SPLIT]: '人工育王分群',
  [EVENT_TYPES.MERGE]: '合并',
  [EVENT_TYPES.REHOUSE]: '过箱',
  [EVENT_TYPES.NATURAL_DEATH]: '自然死亡',
  [EVENT_TYPES.MERGED_OUT]: '并入后注销',
});

const HIVE_STATUS_AT_TIME = Object.freeze({
  ALIVE: 'alive',
  SPLIT_FROM: 'split_from',
  MERGED_INTO: 'merged_into',
  DIED: 'died',
  REHOUSED: 'rehoused',
  NOT_YET_CREATED: 'not_yet_created',
});

function validEventType(t) {
  return Object.values(EVENT_TYPES).includes(t);
}

function labelOfEventType(t) {
  return EVENT_TYPE_LABELS[t] || t;
}

/**
 * 按事件发生时间 + 事件 id 升序排序（保证时间线稳定）。
 */
function sortEventsChronologically(events) {
  return [...events].sort((a, b) => {
    const d = a.eventDate.localeCompare(b.eventDate);
    if (d !== 0) return d;
    return a.id - b.id;
  });
}

/**
 * 建立辅助索引，返回：
 *   byEventId       -> Map<eventId, event>
 *   relsByEventId   -> Map<eventId, Relation[]>
 *   relsByHiveId    -> Map<hiveId, Relation[]>
 *   sourcesByEvent  -> Map<eventId, Relation[]> (role=source)
 *   targetsByEvent  -> Map<eventId, Relation[]> (role=target)
 */
function buildIndexes(events, relations) {
  const byEventId = new Map();
  const relsByEventId = new Map();
  const relsByHiveId = new Map();
  const sourcesByEvent = new Map();
  const targetsByEvent = new Map();

  for (const ev of events) {
    byEventId.set(ev.id, ev);
    relsByEventId.set(ev.id, []);
    sourcesByEvent.set(ev.id, []);
    targetsByEvent.set(ev.id, []);
  }
  for (const r of relations) {
    if (!relsByEventId.has(r.eventId)) relsByEventId.set(r.eventId, []);
    relsByEventId.get(r.eventId).push(r);

    if (!relsByHiveId.has(r.hiveId)) relsByHiveId.set(r.hiveId, []);
    relsByHiveId.get(r.hiveId).push(r);

    if (r.role === 'source') {
      if (!sourcesByEvent.has(r.eventId)) sourcesByEvent.set(r.eventId, []);
      sourcesByEvent.get(r.eventId).push(r);
    } else if (r.role === 'target') {
      if (!targetsByEvent.has(r.eventId)) targetsByEvent.set(r.eventId, []);
      targetsByEvent.get(r.eventId).push(r);
    }
  }
  return { byEventId, relsByEventId, relsByHiveId, sourcesByEvent, targetsByEvent };
}

/* ------------------------------------------------------------------ */
/*  1. 异常检测（循环合并、重复存活、死亡后再参与等）                  */
/* ------------------------------------------------------------------ */

/**
 * 校验事件链的合法性。返回 Anomaly[]：
 *   { type, severity: 'error'|'warn', message, eventId?, hiveIds? }
 *
 * 校验项：
 *   E1 循环合并：从某群出发沿"被并入(target of merge)"走回自己
 *   E2 重复存活：一群在"已死亡/已并入注销"后又作为 source 参与后续事件
 *   E3 守恒偏差超阈值（|frameDiff| > 2 脾视为 warn，>5 视为 error）
 *   E4 事件结构不符合类型（如 merge 应有多个 source、1 个 target；death 只有 1 source 无 target 等）
 *   E5 同事件内 source/target 重叠（一群既被并又是接收群等无意义结构）
 */
function detectAnomalies(events, relations) {
  const anomalies = [];
  const sorted = sortEventsChronologically(events);
  const idx = buildIndexes(events, relations);

  for (const ev of sorted) {
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    const targets = idx.targetsByEvent.get(ev.id) || [];

    const sourceIds = new Set(sources.map((r) => r.hiveId));
    const targetIds = new Set(targets.map((r) => r.hiveId));
    // 对 MERGE 事件，target（接收群）同时出现在 sources 中是正常建模（"合并前后的同一群"），故跳过 E5
    if (ev.eventType !== EVENT_TYPES.MERGE) {
      for (const sid of sourceIds) {
        if (targetIds.has(sid)) {
          anomalies.push({
            type: 'E5_OVERLAP_SOURCE_TARGET',
            severity: 'error',
            message: `事件 #${ev.id} (${labelOfEventType(ev.eventType)}) 中蜂群 #${sid} 同时出现在 source 与 target`,
            eventId: ev.id,
            hiveIds: [sid],
          });
        }
      }
    }

    switch (ev.eventType) {
      case EVENT_TYPES.MERGE: {
        if (sources.length < 2) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `合并事件 #${ev.id} source 数=${sources.length}，至少需要 2 群`,
            eventId: ev.id,
          });
        }
        if (targets.length !== 1) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `合并事件 #${ev.id} target 数=${targets.length}，必须为 1 群`,
            eventId: ev.id,
          });
        }
        break;
      }
      case EVENT_TYPES.NATURAL_SWARM:
      case EVENT_TYPES.ARTIFICIAL_SPLIT: {
        if (sources.length !== 1) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `分蜂事件 #${ev.id} source 数=${sources.length}，必须为 1 群`,
            eventId: ev.id,
          });
        }
        if (targets.length < 1) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `分蜂事件 #${ev.id} target 数=${targets.length}，至少 1 个新群`,
            eventId: ev.id,
          });
        }
        break;
      }
      case EVENT_TYPES.REHOUSE: {
        if (sources.length !== 1 || targets.length !== 1) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `过箱事件 #${ev.id} source=${sources.length} target=${targets.length}，都必须为 1`,
            eventId: ev.id,
          });
        }
        break;
      }
      case EVENT_TYPES.NATURAL_DEATH:
      case EVENT_TYPES.MERGED_OUT: {
        if (sources.length < 1) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'error',
            message: `注销/死亡事件 #${ev.id} source 数=${sources.length}，至少 1 群`,
            eventId: ev.id,
          });
        }
        if (targets.length !== 0) {
          anomalies.push({
            type: 'E4_BAD_STRUCTURE',
            severity: 'warn',
            message: `注销/死亡事件 #${ev.id} 不应有 target，但有 ${targets.length} 个`,
            eventId: ev.id,
          });
        }
        break;
      }
      default:
        break;
    }

    if (Math.abs(ev.frameDiff || 0) > 5) {
      anomalies.push({
        type: 'E3_FRAME_DIFF_LARGE',
        severity: 'error',
        message: `事件 #${ev.id} 脾数差异 ${ev.frameDiff} 超过 5 脾`,
        eventId: ev.id,
      });
    } else if (Math.abs(ev.frameDiff || 0) > 2) {
      anomalies.push({
        type: 'E3_FRAME_DIFF_LARGE',
        severity: 'warn',
        message: `事件 #${ev.id} 脾数差异 ${ev.frameDiff} 超过 2 脾`,
        eventId: ev.id,
      });
    }
  }

  const terminalStatus = computeHiveTerminalStatuses(sorted, idx);
  for (const ev of sorted) {
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    for (const src of sources) {
      const prior = terminalStatus.get(src.hiveId);
      if (prior && prior.beforeEventId < ev.id && prior.kind !== 'alive') {
        anomalies.push({
          type: 'E2_USE_AFTER_TERMINATED',
          severity: 'error',
          message: `蜂群 #${src.hiveId} 在事件 #${prior.eventId} 已${labelOfEventType(prior.kind)}，却又作为 source 出现在事件 #${ev.id}`,
          eventId: ev.id,
          hiveIds: [src.hiveId],
        });
      }
    }
  }

  const cycles = detectMergeCycles(events, relations, idx);
  for (const cycle of cycles) {
    anomalies.push({
      type: 'E1_CYCLE_MERGE',
      severity: 'error',
      message: `检测到循环合并：${cycle.hiveIds.map((id) => '#' + id).join(' → ')} → #${cycle.hiveIds[0]}`,
      eventId: cycle.eventIds[0],
      hiveIds: cycle.hiveIds,
    });
  }

  return anomalies;
}

/**
 * 追踪每一群的"最终处置"事件（被并入/死亡/过箱迁出/分蜂的母群不算终止）。
 * 返回 Map<hiveId, { kind, eventId, beforeEventId }>
 *   kind: 'merged_out' | 'natural_death' | 'rehouse_out' | 'alive'
 */
function computeHiveTerminalStatuses(sortedEvents, idx) {
  const term = new Map();
  for (const ev of sortedEvents) {
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    let kind = null;
    if (ev.eventType === EVENT_TYPES.MERGE || ev.eventType === EVENT_TYPES.MERGED_OUT) kind = EVENT_TYPES.MERGED_OUT;
    else if (ev.eventType === EVENT_TYPES.NATURAL_DEATH) kind = EVENT_TYPES.NATURAL_DEATH;
    else if (ev.eventType === EVENT_TYPES.REHOUSE) kind = 'rehouse_out';
    if (!kind) continue;
    for (const src of sources) {
      if (!term.has(src.hiveId)) {
        term.set(src.hiveId, { kind, eventId: ev.id, beforeEventId: ev.id });
      }
    }
  }
  return term;
}

/**
 * 合并关系构成有向图：source(h) → mergeEvent → target(h')，h 算作指向 h'。
 * 对每个节点做一次 DFS 检测是否回到自己。
 */
function detectMergeCycles(events, relations, idx) {
  const adj = new Map();
  const edgeInfo = [];
  for (const ev of events) {
    if (ev.eventType !== EVENT_TYPES.MERGE) continue;
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    const targets = idx.targetsByEvent.get(ev.id) || [];
    for (const s of sources) {
      for (const t of targets) {
        if (!adj.has(s.hiveId)) adj.set(s.hiveId, []);
        adj.get(s.hiveId).push(t.hiveId);
        edgeInfo.push({ from: s.hiveId, to: t.hiveId, eventId: ev.id });
      }
    }
  }
  const cycles = [];
  const seenCycles = new Set();
  for (const start of adj.keys()) {
    const stack = [{ node: start, path: [start], events: [] }];
    while (stack.length) {
      const { node, path, events } = stack.pop();
      const nexts = adj.get(node) || [];
      for (const nxt of nexts) {
        const evt = edgeInfo.find((e) => e.from === node && e.to === nxt);
        if (nxt === start && path.length >= 2) {
          const key = [...path].sort((a, b) => a - b).join('-');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push({ hiveIds: [...path], eventIds: events.concat(evt ? evt.eventId : []) });
          }
        } else if (!path.includes(nxt)) {
          stack.push({ node: nxt, path: path.concat(nxt), events: events.concat(evt ? evt.eventId : []) });
        }
      }
    }
  }
  return cycles;
}

/* ------------------------------------------------------------------ */
/*  2. 守恒核算（单事件 + 整个事件链汇总）                             */
/* ------------------------------------------------------------------ */

/**
 * 核算一个事件的理论守恒情况。返回：
 *   {
 *     eventId, eventType,
 *     sourceFrames: Number,          // source 侧脾数合计（分蜂用母群当前；合并用被并群各自快照之和）
 *     targetFrames: Number,          // target 侧脾数合计
 *     expectedDiff: Number,          // source - target（应为 0 ± 记录偏差）
 *     actualDiffRecorded: Number,    // 事件本身记录的 frameDiff
 *     discrepancy: Number,           // expectedDiff - actualDiffRecorded
 *     breakdown: { sources, targets, note }
 *   }
 */
function computeEventConservation(event, relations, idx) {
  const sources = (idx ? idx.sourcesByEvent.get(event.id) : undefined) || relations.filter((r) => r.eventId === event.id && r.role === 'source');
  const targets = (idx ? idx.targetsByEvent.get(event.id) : undefined) || relations.filter((r) => r.eventId === event.id && r.role === 'target');

  let sourceFrames = 0;
  let targetFrames = 0;

  switch (event.eventType) {
    case EVENT_TYPES.NATURAL_SWARM:
    case EVENT_TYPES.ARTIFICIAL_SPLIT: {
      const mother = sources[0];
      const motherFrames = mother ? (mother.frameCount || 0) : 0;
      sourceFrames = motherFrames;
      let movedTotal = 0;
      for (const t of targets) movedTotal += t.framesMoved || t.frameCount || 0;
      const motherRemain = motherFrames - movedTotal;
      targetFrames = motherRemain + movedTotal;
      break;
    }
    case EVENT_TYPES.MERGE: {
      for (const s of sources) sourceFrames += s.frameCount || 0;
      for (const t of targets) targetFrames += t.frameCount || 0;
      break;
    }
    case EVENT_TYPES.REHOUSE: {
      const s = sources[0];
      const t = targets[0];
      sourceFrames = s ? s.frameCount || 0 : 0;
      targetFrames = t ? t.frameCount || 0 : 0;
      break;
    }
    case EVENT_TYPES.NATURAL_DEATH:
    case EVENT_TYPES.MERGED_OUT: {
      for (const s of sources) sourceFrames += s.frameCount || 0;
      targetFrames = 0;
      break;
    }
    default:
      break;
  }

  const expectedDiff = sourceFrames - targetFrames;
  const actualDiffRecorded = event.frameDiff || 0;

  return {
    eventId: event.id,
    eventType: event.eventType,
    eventTypeLabel: labelOfEventType(event.eventType),
    sourceFrames,
    targetFrames,
    expectedDiff,
    actualDiffRecorded,
    discrepancy: expectedDiff - actualDiffRecorded,
    breakdown: {
      sources: sources.map((r) => ({ hiveId: r.hiveId, frameCount: r.frameCount, framesMoved: r.framesMoved })),
      targets: targets.map((r) => ({ hiveId: r.hiveId, frameCount: r.frameCount, framesMoved: r.framesMoved })),
      eventNote: event.note || null,
      frameDiffNote: event.frameDiffNote || null,
    },
  };
}

/**
 * 批量核算所有事件，另加一个总计汇总。
 */
function computeAllConservation(events, relations) {
  const idx = buildIndexes(events, relations);
  const perEvent = events.map((ev) => computeEventConservation(ev, relations, idx));
  let totalSourceFrames = 0;
  let totalTargetFrames = 0;
  let totalRecordedDiff = 0;
  for (const r of perEvent) {
    totalSourceFrames += r.sourceFrames;
    totalTargetFrames += r.targetFrames;
    totalRecordedDiff += r.actualDiffRecorded;
  }
  return {
    perEvent,
    summary: {
      eventCount: events.length,
      totalSourceFrames,
      totalTargetFrames,
      totalExpectedDiff: totalSourceFrames - totalTargetFrames,
      totalRecordedDiff,
      netDiscrepancy: totalSourceFrames - totalTargetFrames - totalRecordedDiff,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  3. 编号沿革追溯（某群的前世今生：来源 → 分出 → 归宿）              */
/* ------------------------------------------------------------------ */

/**
 * 追溯单群的完整编号沿革。
 * 返回 { hiveId, origin, descendants, terminus, timeline: EventNode[] }
 *
 *   origin     = null 或 { fromHiveIds, eventId, eventType, eventDate, roleInEvent }
 *   descendants= [{ toHiveId, eventId, eventType, eventDate, relation }]
 *   terminus   = null 或 { intoHiveId?, eventId, eventType, eventDate }
 *   timeline   = 按时间排序、该群直接参与过的所有事件节点（含快照脾数）
 */
function traceLineage(hiveId, events, relations) {
  const idx = buildIndexes(events, relations);
  const myRels = (idx.relsByHiveId.get(hiveId) || []).slice();
  const timeline = [];
  for (const r of myRels) {
    const ev = idx.byEventId.get(r.eventId);
    if (!ev) continue;
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    const targets = idx.targetsByEvent.get(ev.id) || [];
    timeline.push({
      eventId: ev.id,
      eventType: ev.eventType,
      eventTypeLabel: labelOfEventType(ev.eventType),
      eventDate: ev.eventDate,
      role: r.role,
      frameSnapshot: r.frameCount,
      strengthSnapshot: r.strength,
      framesMoved: r.framesMoved,
      participants: {
        sources: sources.map((s) => ({ hiveId: s.hiveId, frameCount: s.frameCount })),
        targets: targets.map((t) => ({ hiveId: t.hiveId, frameCount: t.frameCount })),
      },
      note: ev.note || null,
    });
  }
  timeline.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.eventId - b.eventId);

  let origin = null;
  const descendants = [];
  let terminus = null;

  for (const node of timeline) {
    const meAsSource = node.role === 'source';
    const meAsTarget = node.role === 'target';

    if (meAsTarget && (node.eventType === EVENT_TYPES.NATURAL_SWARM || node.eventType === EVENT_TYPES.ARTIFICIAL_SPLIT || node.eventType === EVENT_TYPES.REHOUSE || node.eventType === EVENT_TYPES.MERGE)) {
      const mothers = node.participants.sources.filter((s) => s.hiveId !== hiveId);
      if (!origin && mothers.length) {
        origin = {
          fromHiveIds: mothers.map((m) => m.hiveId),
          eventId: node.eventId,
          eventType: node.eventType,
          eventDate: node.eventDate,
          roleInEvent: 'target',
        };
      }
    }

    if (meAsSource && (node.eventType === EVENT_TYPES.NATURAL_SWARM || node.eventType === EVENT_TYPES.ARTIFICIAL_SPLIT || node.eventType === EVENT_TYPES.REHOUSE || node.eventType === EVENT_TYPES.MERGE)) {
      const kids = node.participants.targets.filter((t) => t.hiveId !== hiveId);
      for (const k of kids) {
        descendants.push({
          toHiveId: k.hiveId,
          eventId: node.eventId,
          eventType: node.eventType,
          eventDate: node.eventDate,
          relation: node.eventType === EVENT_TYPES.MERGE ? 'merged_into' : 'parent_of',
        });
      }
    }

    if (meAsSource && (node.eventType === EVENT_TYPES.NATURAL_DEATH || node.eventType === EVENT_TYPES.MERGED_OUT || node.eventType === EVENT_TYPES.REHOUSE || node.eventType === EVENT_TYPES.MERGE)) {
      if (!terminus) {
        const into = node.participants.targets.find((t) => t.hiveId !== hiveId);
        terminus = {
          eventId: node.eventId,
          eventType: node.eventType,
          eventDate: node.eventDate,
          intoHiveId: into ? into.hiveId : null,
        };
      }
    }
  }

  return { hiveId, origin, descendants, terminus, timeline };
}

/**
 * 递归向上追溯源头（所有祖先），返回节点集合与路径。
 */
function traceAncestors(hiveId, events, relations, maxDepth = 32) {
  const visited = new Set();
  const ancestors = [];
  const stack = [{ id: hiveId, depth: 0, path: [hiveId] }];
  while (stack.length) {
    const { id, depth, path } = stack.pop();
    if (depth >= maxDepth) continue;
    const lineageObj = traceLineage(id, events, relations);
    if (!lineageObj.origin || !lineageObj.origin.fromHiveIds) continue;
    for (const pid of lineageObj.origin.fromHiveIds) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      ancestors.push({ hiveId: pid, depth: depth + 1, path: path.concat(pid), viaEventId: lineageObj.origin.eventId, viaEventType: lineageObj.origin.eventType });
      stack.push({ id: pid, depth: depth + 1, path: path.concat(pid) });
    }
  }
  return ancestors;
}

/**
 * 递归向下追溯所有后代。
 */
function traceDescendants(hiveId, events, relations, maxDepth = 32) {
  const visited = new Set();
  const descendants = [];
  const stack = [{ id: hiveId, depth: 0, path: [hiveId] }];
  while (stack.length) {
    const { id, depth, path } = stack.pop();
    if (depth >= maxDepth) continue;
    const lineageObj = traceLineage(id, events, relations);
    for (const d of lineageObj.descendants) {
      if (visited.has(d.toHiveId)) continue;
      visited.add(d.toHiveId);
      descendants.push({ hiveId: d.toHiveId, depth: depth + 1, path: path.concat(d.toHiveId), viaEventId: d.eventId, viaEventType: d.eventType, relation: d.relation });
      stack.push({ id: d.toHiveId, depth: depth + 1, path: path.concat(d.toHiveId) });
    }
  }
  return descendants;
}

/* ------------------------------------------------------------------ */
/*  4. 任意历史时点的状态重建                                          */
/* ------------------------------------------------------------------ */

/**
 * 重建在 pointInTime (ISO 字符串或 YYYY-MM-DD) 时刻每一群的状态。
 * 仅考虑 eventDate <= pointInTime 的事件（同日内按事件 id 先后）。
 *
 * 返回 Map<hiveId, HiveStateAtTime>
 *   HiveStateAtTime = {
 *     status: 'alive' | 'split_from' | 'merged_into' | 'died' | 'rehoused' | 'not_yet_created',
 *     frameCount, strength,          // 此时点的估算值（基于最后一次快照/创建值）
 *     lastEventId, lastEventType,    // 最近一次影响它的事件
 *     createdAtEventId?,             // 由哪次事件创建（分蜂/过箱/合并产出）
 *   }
 */
function reconstructStateAt(pointInTime, events, relations, hives) {
  const idx = buildIndexes(events, relations);
  const relevantEvents = sortEventsChronologically(events).filter(
    (ev) => ev.eventDate.localeCompare(pointInTime) <= 0
  );

  const state = new Map();
  for (const h of hives) {
    state.set(h.id, {
      status: HIVE_STATUS_AT_TIME.NOT_YET_CREATED,
      frameCount: h.frameCount,
      strength: h.strength,
      lastEventId: null,
      lastEventType: null,
      createdAtEventId: null,
      originCode: h.code,
      installedAt: h.installedAt,
    });
    if (!h.installedAt || h.installedAt.localeCompare(pointInTime) <= 0) {
      state.get(h.id).status = HIVE_STATUS_AT_TIME.ALIVE;
    }
  }

  for (const ev of relevantEvents) {
    const sources = idx.sourcesByEvent.get(ev.id) || [];
    const targets = idx.targetsByEvent.get(ev.id) || [];

    for (const t of targets) {
      if (!state.has(t.hiveId)) {
        state.set(t.hiveId, {
          status: HIVE_STATUS_AT_TIME.ALIVE,
          frameCount: t.frameCount || 0,
          strength: t.strength || 'medium',
          lastEventId: ev.id,
          lastEventType: ev.eventType,
          createdAtEventId: ev.id,
        });
      } else {
        const s = state.get(t.hiveId);
        if (t.frameCount != null) s.frameCount = t.frameCount;
        if (t.strength) s.strength = t.strength;
        s.lastEventId = ev.id;
        s.lastEventType = ev.eventType;
        if (s.status === HIVE_STATUS_AT_TIME.NOT_YET_CREATED) s.status = HIVE_STATUS_AT_TIME.ALIVE;
        if (!s.createdAtEventId) s.createdAtEventId = ev.id;
      }
    }

    for (const s of sources) {
      if (!state.has(s.hiveId)) continue;
      const st = state.get(s.hiveId);
      if (s.frameCount != null) st.frameCount = s.frameCount;
      if (s.strength) st.strength = s.strength;
      st.lastEventId = ev.id;
      st.lastEventType = ev.eventType;

      switch (ev.eventType) {
        case EVENT_TYPES.MERGE:
        case EVENT_TYPES.MERGED_OUT:
          st.status = HIVE_STATUS_AT_TIME.MERGED_INTO;
          break;
        case EVENT_TYPES.NATURAL_DEATH:
          st.status = HIVE_STATUS_AT_TIME.DIED;
          break;
        case EVENT_TYPES.REHOUSE:
          st.status = HIVE_STATUS_AT_TIME.REHOUSED;
          break;
        case EVENT_TYPES.NATURAL_SWARM:
        case EVENT_TYPES.ARTIFICIAL_SPLIT: {
          let moved = 0;
          for (const t of targets) moved += t.framesMoved || 0;
          if (st.frameCount != null) st.frameCount = Math.max(0, st.frameCount - moved);
          st.status = HIVE_STATUS_AT_TIME.ALIVE;
          break;
        }
        default:
          break;
      }
    }
  }

  return state;
}

/**
 * 汇总：某时点蜂场实际存活群数，及按 apiary 分组。
 */
function summarizeAliveAt(pointInTime, events, relations, hives) {
  const state = reconstructStateAt(pointInTime, events, relations, hives);
  const alive = [];
  const byApiary = new Map();
  for (const [hid, s] of state.entries()) {
    if (s.status === HIVE_STATUS_AT_TIME.ALIVE) {
      const hive = hives.find((h) => h.id === hid);
      const rec = { hiveId: hid, code: hive ? hive.code : `#${hid}`, apiaryId: hive ? hive.apiaryId : null, frameCount: s.frameCount, strength: s.strength, lastEventId: s.lastEventId };
      alive.push(rec);
      const key = rec.apiaryId ?? 'none';
      if (!byApiary.has(key)) byApiary.set(key, []);
      byApiary.get(key).push(rec);
    }
  }
  return { pointInTime, totalAlive: alive.length, alive, byApiary: Object.fromEntries(byApiary.entries()) };
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  HIVE_STATUS_AT_TIME,
  validEventType,
  labelOfEventType,
  sortEventsChronologically,
  buildIndexes,
  detectAnomalies,
  computeEventConservation,
  computeAllConservation,
  traceLineage,
  traceAncestors,
  traceDescendants,
  reconstructStateAt,
  summarizeAliveAt,
};
