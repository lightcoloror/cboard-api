'use strict';
const { DAY, fail } = require('./carePolicy');
const valid = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const clone = v => JSON.parse(JSON.stringify(v));
const PACK_TYPES = ['trial', 'initial_bonus', 'purchased'];
// One encrypted funding document is the atomic boundary for balance, delegate
// caps and durable receipts. No process-local lock is used for charging.
function createCareBudget({ store, encryption, now = Date.now }) {
  async function load(id) {
    if (!valid(id)) fail(400, 'INVALID_FUNDING_ACCOUNT');
    const doc = await store.get(id);
    if (!doc) fail(403, 'FUNDING_ACCESS_DENIED');
    return { doc, state: encryption.open(doc.sealed, `funding:${id}`) };
  }
  async function mutate(id, fn) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { doc, state } = await load(id);
      const result = fn(state);
      if (result.noWrite) return result.value;
      if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) fail(413, 'FUNDING_CAPACITY_REACHED');
      if (await store.cas(id, doc.rev, { rev: doc.rev + 1, members: Object.keys(state.grants).filter(u => !state.grants[u].revoked), sealed: encryption.seal(state, `funding:${id}`) })) return result.value;
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }
  function week(state) {
    const anchor = state.startsAt;
    const index = Math.max(0, Math.floor((now() - anchor) / (7 * DAY)));
    return { key: String(index), resetAt: anchor + (index + 1) * 7 * DAY };
  }
  function grant(state, actor, profileId) {
    const g = state.grants[actor];
    if (!g || g.revoked || (g.profileIds && !g.profileIds.includes(profileId))) fail(403, 'FUNDING_ACCESS_DENIED');
    return g;
  }
  function buckets(state) {
    const w = week(state);
    return [
      ...(now() >= state.startsAt && now() < state.expiresAt ? [{ id: `week:${w.key}`, remaining: Math.max(0, state.weeklyLimit - (state.weekUsed[w.key] || 0)), expiresAt: Math.min(w.resetAt, state.expiresAt) }] : []),
      ...state.packs.filter(p => p.startsAt <= now() && now() < p.expiresAt).map(p => ({ id: `pack:${p.id}`, remaining: Math.max(0, p.amount - p.used), expiresAt: p.expiresAt }))
    ].sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
  }
  function apply(state, allocation, amount) {
    if (allocation.id.startsWith('week:')) {
      const key = allocation.id.slice(5); state.weekUsed[key] = (state.weekUsed[key] || 0) + amount;
    } else {
      const p = state.packs.find(p => p.id === allocation.id.slice(5));
      if (!p) fail(503, 'FUNDING_LEDGER_CORRUPT');
      p.used += amount;
    }
  }
  return {
    // Called only by trusted provisioning, never from a client supplied plan.
    async provision(id, value) {
      if (!valid(id) || !valid(value.owner) || !['family', 'institution'].includes(value.kind) || !Number.isSafeInteger(value.weeklyLimit) || value.weeklyLimit < 0 || !Number.isSafeInteger(value.startsAt) || !(value.expiresAt > value.startsAt)) fail(400, 'INVALID_FUNDING_CONFIG');
      const state = { kind: value.kind, owner: value.owner, familyId: value.familyId || null,
        startsAt: value.startsAt, expiresAt: value.expiresAt, weeklyLimit: value.weeklyLimit,
        grants: { [value.owner]: { limit: null, profileIds: null, revoked: false } }, weekUsed: {}, delegateUsed: {}, packs: [], receipts: {} };
      if (!await store.create({ _id: id, rev: 0, kind: state.kind, familyId: state.familyId, owner: state.owner, members: [state.owner], sealed: encryption.seal(state, `funding:${id}`) })) fail(409, 'FUNDING_EXISTS');
      return { id };
    },
    async renew(id, expiresAt) {
      return mutate(id, state => { if (!(expiresAt > state.expiresAt)) fail(400, 'INVALID_RENEWAL'); state.expiresAt = expiresAt; return { value: { ok: true } }; });
    },
    async addPack(id, pack) {
      if (!valid(pack.id) || !PACK_TYPES.includes(pack.type) || !positive(pack.amount) || !Number.isSafeInteger(pack.startsAt)) fail(400, 'INVALID_CREDIT_PACK');
      const expiresAt = pack.type === 'purchased' ? pack.startsAt + 30 * DAY : pack.expiresAt;
      if (!(expiresAt > pack.startsAt)) fail(400, 'PACK_POLICY_NOT_CONFIGURED');
      return mutate(id, state => {
        const existing = state.packs.find(p => p.id === pack.id);
        const value = { id: pack.id, type: pack.type, amount: pack.amount, startsAt: pack.startsAt, expiresAt, used: 0 };
        if (existing) {
          if (JSON.stringify({ ...existing, used: 0 }) !== JSON.stringify(value)) fail(409, 'PACK_ID_REUSED');
          return { noWrite: true, value: { ok: true } };
        }
        state.packs.push(value); return { value: { ok: true } };
      });
    },
    async delegate(id, actor, body) {
      if (!valid(body.member) || !positive(body.limit) || !Array.isArray(body.profileIds) || !body.profileIds.length || body.profileIds.some(p => !valid(p))) fail(400, 'INVALID_DELEGATION');
      return mutate(id, state => {
        if (state.owner !== actor || body.member === state.owner) fail(403, 'FUNDING_ADMIN_REQUIRED');
        state.grants[body.member] = { limit: body.limit, profileIds: [...new Set(body.profileIds)], revoked: body.revoked === true };
        return { value: { ok: true } };
      });
    },
    async snapshot(id, actor, profileId) {
      const { state } = await load(id); const g = grant(state, actor, profileId); const w = week(state);
      return { id, kind: state.kind, canManage: state.owner === actor, resetAt: w.resetAt, weeklyLimit: state.weeklyLimit,
        weeklyUsed: state.weekUsed[w.key] || 0, available: buckets(state).reduce((n, b) => n + b.remaining, 0),
        delegatedLimit: g.limit, delegatedUsed: state.delegateUsed[`${actor}:${w.key}`] || 0,
        pendingRequests: Object.values(state.receipts).filter(r => r.status === 'reserved' && r.profileId === profileId && (actor === state.owner || r.actor === actor)).map(r => ({ requestId: r.requestId, actor: r.actor, reserved: r.reserved, createdAt: r.createdAt })),
        packs: state.packs.map(({ id, type, amount, used, startsAt, expiresAt }) => ({ id, type, amount, used, startsAt, expiresAt })) };
    },
    async reserve(id, { actor, profileId, requestId, units, fingerprint }) {
      if (!valid(requestId) || !positive(units) || !/^[a-f0-9]{64}$/.test(fingerprint || '')) fail(400, 'INVALID_USAGE_REQUEST');
      return mutate(id, state => {
        const g = grant(state, actor, profileId);
        const key = `${actor}:${requestId}`; const old = state.receipts[key];
        if (old) {
          if (old.fingerprint !== fingerprint || old.profileId !== profileId || old.reserved !== units) fail(409, 'USAGE_ID_REUSED');
          return { noWrite: true, value: { ...old, duplicate: true } };
        }
        const w = week(state), delegateKey = `${actor}:${w.key}`;
        const used = state.delegateUsed[delegateKey] || 0;
        if (g.limit !== null && used + units > g.limit) fail(429, 'DELEGATED_QUOTA_EXCEEDED');
        const available = buckets(state);
        if (available.reduce((n, b) => n + b.remaining, 0) < units) fail(429, 'AI_QUOTA_EXCEEDED');
        let remaining = units; const allocations = [];
        for (const b of available) {
          const amount = Math.min(b.remaining, remaining);
          if (amount) { allocations.push({ id: b.id, expiresAt: b.expiresAt, amount }); apply(state, b, amount); remaining -= amount; }
          if (!remaining) break;
        }
        state.delegateUsed[delegateKey] = used + units;
        const receipt = { actor, requestId, profileId, fingerprint, reserved: units, status: 'reserved', allocations, delegateKey, createdAt: now() };
        state.receipts[key] = receipt;
        return { value: clone(receipt) };
      });
    },
    async settle(id, actor, requestId, actualUnits, evidenceId) {
      if (!Number.isSafeInteger(actualUnits) || actualUnits < 0) fail(400, 'INVALID_SETTLEMENT');
      if (evidenceId !== undefined && !valid(evidenceId)) fail(400, 'INVALID_RECONCILIATION_EVIDENCE');
      return mutate(id, state => {
        const receipt = state.receipts[`${actor}:${requestId}`];
        if (!receipt) fail(404, 'USAGE_NOT_FOUND');
        if (receipt.status !== 'reserved') {
          if (receipt.actual !== actualUnits) fail(409, 'SETTLEMENT_MISMATCH');
          return { noWrite: true, value: clone(receipt) };
        }
        if (actualUnits > receipt.reserved) fail(409, 'USAGE_EXCEEDS_RESERVATION');
        let refund = receipt.reserved - actualUnits;
        for (const a of [...receipt.allocations].reverse()) {
          const amount = Math.min(refund, a.amount); apply(state, a, -amount); refund -= amount;
          if (!refund) break;
        }
        state.delegateUsed[receipt.delegateKey] -= receipt.reserved - actualUnits;
        receipt.status = actualUnits === 0 ? 'released' : 'settled'; receipt.actual = actualUnits; receipt.settledAt = now();
        if (evidenceId) receipt.reconciliationEvidence = evidenceId;
        return { value: clone(receipt) };
      });
    }
  };
}
module.exports = { createCareBudget, PACK_TYPES };
