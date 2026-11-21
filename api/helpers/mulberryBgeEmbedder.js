'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_EMBED_DIM = 512;
const DEFAULT_CACHE_SIZE = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_WORKER_SCRIPT = path.resolve(__dirname, '../../scripts/bgeEmbedWorker.py');

function normalizeQueryText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function normalizeEmbeddingVector(raw, expectedDim = DEFAULT_EMBED_DIM) {
  if (!raw || (typeof raw.length !== 'number')) return null;
  if (raw.length !== expectedDim) return null;
  const vec = new Float32Array(expectedDim);
  let normSq = 0;
  for (let i = 0; i < expectedDim; i += 1) {
    const val = Number(raw[i]);
    if (!Number.isFinite(val)) return null;
    vec[i] = val;
    normSq += val * val;
  }
  if (normSq <= 0) return null;
  return vec;
}

function createLruCache(maxSize = DEFAULT_CACHE_SIZE) {
  const cap = Math.max(16, Math.min(4096, Number(maxSize) || DEFAULT_CACHE_SIZE));
  const map = new Map();

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const val = map.get(key);
      map.delete(key);
      map.set(key, val);
      return val;
    },
    set(key, value) {
      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= cap) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
      }
      map.set(key, value);
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    }
  };
}

function createHttpBgeEmbedder({
  url,
  apiKey = '',
  model = 'bge-small-zh-v1.5',
  expectedDim = DEFAULT_EMBED_DIM,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxCacheSize = DEFAULT_CACHE_SIZE,
  fetchImpl = typeof fetch === 'function' ? fetch : null
} = {}) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) {
    throw new Error('HTTP embedder url is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const cache = createLruCache(maxCacheSize);
  const stats = { requests: 0, cacheHits: 0, failures: 0 };
  let closed = false;

  return {
    mode: 'http',

    async embed(rawText) {
      if (closed) return null;
      const cleanText = normalizeQueryText(rawText);
      if (!cleanText) return null;

      const cached = cache.get(cleanText);
      if (cached) {
        stats.cacheHits += 1;
        return cached;
      }

      stats.requests += 1;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const res = await fetchImpl(cleanUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: cleanText }),
          ...(controller ? { signal: controller.signal } : {})
        });
        if (!res || !res.ok) {
          stats.failures += 1;
          return null;
        }
        const payload = await res.json();
        const rawVec =
          (payload && Array.isArray(payload.data) && payload.data[0] && payload.data[0].embedding) ||
          (payload && payload.vector) ||
          null;
        const normalized = normalizeEmbeddingVector(rawVec, expectedDim);
        if (!normalized) {
          stats.failures += 1;
          return null;
        }
        cache.set(cleanText, normalized);
        return normalized;
      } catch (_) {
        stats.failures += 1;
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    getStats() {
      return {
        mode: 'http',
        cacheSize: cache.size(),
        ...stats
      };
    },

    close() {
      closed = true;
      cache.clear();
    }
  };
}

function createSubprocessBgeEmbedder({
  pythonBin = 'python',
  workerScript = DEFAULT_WORKER_SCRIPT,
  modelPath = '',
  depsPath = '',
  expectedDim = DEFAULT_EMBED_DIM,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxCacheSize = DEFAULT_CACHE_SIZE
} = {}) {
  if (!workerScript || !fs.existsSync(workerScript)) {
    throw new Error(`Missing BGE worker script: ${workerScript}`);
  }

  const cache = createLruCache(maxCacheSize);
  const pending = new Map();
  const stats = { requests: 0, cacheHits: 0, failures: 0, spawns: 0 };

  let child = null;
  let rl = null;
  let readyPromise = null;
  let nextReqId = 1;
  let closed = false;

  function teardownProcess(reasonError) {
    if (rl) {
      try {
        rl.close();
      } catch (_) {
        // Ignore readline close error
      }
      rl = null;
    }
    if (child) {
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.destroy();
        }
        child.kill();
      } catch (_) {
        // Ignore kill error if already exited
      }
      child = null;
    }
    readyPromise = null;
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(reasonError || new Error('BGE worker closed'));
      pending.delete(id);
    }
  }

  function ensureWorkerReady() {
    if (closed) {
      return Promise.reject(new Error('BGE embedder is closed'));
    }
    if (readyPromise) {
      return readyPromise;
    }

    readyPromise = new Promise((resolve, reject) => {
      const args = [workerScript];
      if (modelPath) {
        args.push('--model', modelPath);
      }
      if (depsPath) {
        args.push('--deps', depsPath);
      }

      stats.spawns += 1;
      const spawned = spawn(pythonBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1'
        }
      });
      child = spawned;

      let settledReady = false;
      const startupTimer = setTimeout(() => {
        if (!settledReady) {
          settledReady = true;
          const err = new Error('BGE worker startup timed out');
          teardownProcess(err);
          reject(err);
        }
      }, startupTimeoutMs);

      rl = readline.createInterface({ input: spawned.stdout, crlfDelay: Infinity });

      rl.on('line', line => {
        const clean = String(line || '').trim();
        if (!clean) return;
        let msg;
        try {
          msg = JSON.parse(clean);
        } catch (_) {
          return;
        }

        if (!settledReady && msg && msg.ready) {
          settledReady = true;
          clearTimeout(startupTimer);
          resolve();
          return;
        }

        if (msg && msg.id !== undefined && msg.id !== null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(String(msg.error)));
          } else {
            const vec = normalizeEmbeddingVector(msg.vector, expectedDim);
            if (vec) {
              entry.resolve(vec);
            } else {
              entry.reject(new Error('Invalid BGE vector shape returned by worker'));
            }
          }
        }
      });

      spawned.on('error', err => {
        clearTimeout(startupTimer);
        if (!settledReady) {
          settledReady = true;
          reject(err);
        }
        teardownProcess(err);
      });

      spawned.on('exit', code => {
        clearTimeout(startupTimer);
        const exitErr = new Error(`BGE worker exited with code ${code}`);
        if (!settledReady) {
          settledReady = true;
          reject(exitErr);
        }
        teardownProcess(exitErr);
      });
    });

    return readyPromise;
  }

  return {
    mode: 'subprocess',

    async embed(rawText) {
      if (closed) return null;
      const cleanText = normalizeQueryText(rawText);
      if (!cleanText) return null;

      const cached = cache.get(cleanText);
      if (cached) {
        stats.cacheHits += 1;
        return cached;
      }

      stats.requests += 1;
      try {
        await ensureWorkerReady();
        if (closed || !child || !child.stdin || child.stdin.destroyed) {
          stats.failures += 1;
          return null;
        }

        const reqId = nextReqId;
        nextReqId += 1;

        const vector = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(reqId);
            reject(new Error('BGE worker request timed out'));
          }, requestTimeoutMs);

          pending.set(reqId, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id: reqId, text: cleanText })}\n`, 'utf8');
        });

        cache.set(cleanText, vector);
        return vector;
      } catch (_) {
        stats.failures += 1;
        return null;
      }
    },

    getStats() {
      return {
        mode: 'subprocess',
        alive: Boolean(child),
        cacheSize: cache.size(),
        ...stats
      };
    },

    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      if (child && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`, 'utf8');
        } catch (_) {
          // Ignore write-after-end
        }
      }
      teardownProcess(new Error('BGE embedder closed'));
    }
  };
}

function createAutoBgeEmbedder({
  embedUrl = '',
  embedApiKey = '',
  embedModel = 'bge-small-zh-v1.5',
  modelPath = '',
  depsPath = '',
  pythonBin = 'python',
  workerScript = DEFAULT_WORKER_SCRIPT,
  fetchImpl,
  expectedDim = DEFAULT_EMBED_DIM,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  maxCacheSize = DEFAULT_CACHE_SIZE
} = {}) {
  const cleanUrl = String(embedUrl || '').trim();
  if (cleanUrl) {
    return createHttpBgeEmbedder({
      url: cleanUrl,
      apiKey: embedApiKey,
      model: embedModel,
      expectedDim,
      timeoutMs: requestTimeoutMs,
      maxCacheSize,
      fetchImpl
    });
  }

  const cleanModelPath = String(modelPath || '').trim();
  if (cleanModelPath && fs.existsSync(cleanModelPath)) {
    return createSubprocessBgeEmbedder({
      pythonBin,
      workerScript,
      modelPath: cleanModelPath,
      depsPath: String(depsPath || '').trim(),
      expectedDim,
      startupTimeoutMs,
      requestTimeoutMs,
      maxCacheSize
    });
  }

  return null;
}

module.exports = {
  DEFAULT_CACHE_SIZE,
  DEFAULT_EMBED_DIM,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_WORKER_SCRIPT,
  createAutoBgeEmbedder,
  createHttpBgeEmbedder,
  createLruCache,
  createSubprocessBgeEmbedder,
  normalizeEmbeddingVector
};
