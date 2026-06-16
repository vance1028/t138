'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const lineage = require('../data/lineage');

const router = express.Router();
router.use(authRequired);

/* -------------------- 元数据：事件类型枚举 ------------------------ */

router.get('/meta/event-types', (req, res) => {
  sendData(res, 200, {
    types: Object.entries(lineage.EVENT_TYPES).map(([k, v]) => ({ key: k, value: v, label: lineage.EVENT_TYPE_LABELS[v] })),
    hiveStatusAtTime: lineage.HIVE_STATUS_AT_TIME,
  });
});

/* -------------------- 事件列表 / 详情 / 创建 ---------------------- */

router.get('/', (req, res) => {
  const { eventType, apiaryId, hiveId, fromDate, toDate } = req.query;
  const filter = { eventType, fromDate, toDate };
  if (apiaryId !== undefined) filter.apiaryId = Number(apiaryId);
  if (hiveId !== undefined) filter.hiveId = Number(hiveId);
  return sendData(res, 200, store.listColonyEvents(filter));
});

router.get('/:id', (req, res) => {
  try {
    const id = parseId(req.params.id);
    const detail = store.getColonyEventDetail(id);
    if (!detail) return sendError(res, 404, '事件不存在');
    return sendData(res, 200, detail);
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  try {
    const body = req.body || {};
    const detail = store.createColonyEvent(body);
    return sendData(res, 201, detail);
  } catch (e) {
    const statusCode = e.statusCode || 500;
    const payload = { message: e.message };
    if (e.anomalies) payload.anomalies = e.anomalies;
    res.status(statusCode).json({
      ok: false,
      status: statusCode,
      error: payload,
      data: null,
    });
    return;
  }
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!store.getColonyEventById(id)) return sendError(res, 404, '事件不存在');
    store.deleteColonyEvent(id);
    return sendData(res, 200, { id });
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

/* -------------------- 守恒核算 / 异常检测 ------------------------- */

router.get('/conservation/summary', (req, res) => {
  sendData(res, 200, store.getAllConservation());
});

router.get('/conservation/:id', (req, res) => {
  try {
    const id = parseId(req.params.id);
    const r = store.getEventConservation(id);
    if (!r) return sendError(res, 404, '事件不存在');
    return sendData(res, 200, r);
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

router.get('/anomalies/detect', (req, res) => {
  sendData(res, 200, { anomalies: store.getAnomalies() });
});

/* -------------------- 谱系与编号沿革追溯 -------------------------- */

router.get('/hives/:hiveId/lineage', (req, res) => {
  try {
    const hiveId = parseId(req.params.hiveId);
    if (!store.getHiveById(hiveId)) return sendError(res, 404, '蜂箱不存在');
    return sendData(res, 200, store.getHiveLineage(hiveId));
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

router.get('/hives/:hiveId/ancestors', (req, res) => {
  try {
    const hiveId = parseId(req.params.hiveId);
    if (!store.getHiveById(hiveId)) return sendError(res, 404, '蜂箱不存在');
    return sendData(res, 200, store.getHiveAncestors(hiveId));
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

router.get('/hives/:hiveId/descendants', (req, res) => {
  try {
    const hiveId = parseId(req.params.hiveId);
    if (!store.getHiveById(hiveId)) return sendError(res, 404, '蜂箱不存在');
    return sendData(res, 200, store.getHiveDescendants(hiveId));
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

/* -------------------- 历史时点状态重建 ---------------------------- */

router.get('/state/at', (req, res) => {
  const { pointInTime } = req.query;
  if (!pointInTime) return sendError(res, 400, '缺少 pointInTime 参数（YYYY-MM-DD 或 ISO 时间）');
  sendData(res, 200, store.getStateAt(String(pointInTime)));
});

router.get('/alive/at', (req, res) => {
  const { pointInTime } = req.query;
  if (!pointInTime) return sendError(res, 400, '缺少 pointInTime 参数（YYYY-MM-DD 或 ISO 时间）');
  sendData(res, 200, store.getAliveSummaryAt(String(pointInTime)));
});

/* -------------------- 某蜂箱关联事件 ------------------------------ */

router.get('/hives/:hiveId/events', (req, res) => {
  try {
    const hiveId = parseId(req.params.hiveId);
    if (!store.getHiveById(hiveId)) return sendError(res, 404, '蜂箱不存在');
    return sendData(res, 200, store.listColonyEvents({ hiveId }));
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
});

module.exports = router;
