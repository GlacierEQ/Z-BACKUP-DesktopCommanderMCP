// Foundation handlers — connect DesktopCommander to the operator's workstation
// foundation (Hindsight memory, Postgres, model routing, launchd services,
// constitution integrity). Read-only: every probe observes live state and
// never mutates anything.
//
// So any MCP client (local OMP or remote) can see system health in one call.
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ServerResult } from '../types.js';
import {
    FoundationStatusArgsSchema,
    ModelHealthArgsSchema,
    HindsightStatusArgsSchema,
    ConstitutionCheckArgsSchema,
    FoundationAssertArgsSchema,
} from '../tools/schemas.js';

const execAsync = promisify(exec);

const HOME = os.homedir();
const OMP_AGENT = path.join(HOME, '.omp', 'agent');
const HEALTH_URL = 'http://127.0.0.1:8888/health';
const MODEL_HEALTH = path.join(OMP_AGENT, 'model-health.json');
const CONSTITUTION_MANIFEST = path.join(OMP_AGENT, '.constitution.sha256');

function errorMessage(e: unknown): string {
    return String(e instanceof Error ? e.message : e).slice(0, 200);
}

async function httpGet(url: string, timeoutMs = 3000): Promise<{ ok: boolean; detail: string }> {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(t);
        const body = await res.text();
        return { ok: res.ok, detail: body.slice(0, 2000) };
    } catch (e) {
        return { ok: false, detail: errorMessage(e) };
    }
}

async function launchdState(label: string): Promise<string> {
    try {
        const { stdout } = await execAsync(`launchctl list | grep ${label} || true`);
        const line = stdout.trim();
        if (!line) return 'not loaded';
        const parts = line.split(/\s+/);
        const pid = parts[0];
        const exit = parts[1];
        return pid !== '-' ? `running (pid ${pid})` : `loaded (last exit ${exit})`;
    } catch {
        return 'unknown';
    }
}

async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
}

function jsonResult(payload: unknown): ServerResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
}

function errorResult(prefix: string, e: unknown): ServerResult {
    return {
        content: [{ type: 'text', text: `${prefix}: ${errorMessage(e)}` }],
        isError: true,
    };
}

interface ModelEntry {
    selector: string;
    status: string;
    latency_ms?: number;
    detail?: string;
}

async function readModelRegistry(): Promise<{ generated: string | null; models: ModelEntry[] }> {
    if (!(await fileExists(MODEL_HEALTH))) {
        return { generated: null, models: [] };
    }
    const raw = JSON.parse(await fs.readFile(MODEL_HEALTH, 'utf8')) as Record<string, unknown>;
    const models = Array.isArray(raw.models) ? (raw.models as ModelEntry[]) : [];
    const generated = typeof raw.generated === 'string' ? raw.generated : null;
    return { generated, models };
}

const STATUS_RANK: Record<string, number> = { ok: 0, flaky: 1, ratelimit: 2, billing: 3 };

/**
 * handle_foundation_status — one-call health snapshot of the whole stack:
 * Hindsight API, Postgres, launchd services, model routing, constitution.
 */
export async function handleFoundationStatus(args: unknown): Promise<ServerResult> {
    FoundationStatusArgsSchema.parse(args);
    try {
        const hs = await httpGet(HEALTH_URL);
        let hindsightStatus = 'down';
        let hindsightDetail = hs.detail.slice(0, 200);
        if (hs.ok) {
            try {
                const j = JSON.parse(hs.detail) as { status?: string; database?: string };
                hindsightStatus = j.status === 'healthy' ? 'healthy' : 'degraded';
                hindsightDetail = `db=${j.database ?? 'unknown'}`;
            } catch { /* keep raw */ }
        }

        let postgresStatus = 'down';
        try {
            const { stdout } = await execAsync("pgrep -f 'pginstall/bin/postgres' | head -1 || true");
            postgresStatus = stdout.trim() ? 'running' : 'down';
        } catch { /* down */ }

        const launchd: Record<string, string> = {};
        for (const label of ['sh.glaaciereq.postgres', 'sh.glaaciereq.hindsight', 'sh.glaaciereq.llm-watchdog']) {
            launchd[label] = await launchdState(label);
        }

        const registry = await readModelRegistry();
        const alive = registry.models.filter((m) => m.status === 'ok').map((m) => m.selector);
        const modelRouting = {
            healthy: alive.length,
            total: registry.models.length,
            alive,
            generated: registry.generated ?? 'unknown',
        };

        const constitutionPresent = (await fileExists(path.join(OMP_AGENT, 'RULES.md')))
            && (await fileExists(path.join(OMP_AGENT, 'AGENTS.md')));

        return jsonResult({
            timestamp: new Date().toISOString(),
            host: os.hostname(),
            services: {
                hindsight: { status: hindsightStatus, detail: hindsightDetail },
                postgres: { status: postgresStatus },
            },
            launchd,
            modelRouting,
            constitution: { present: constitutionPresent },
        });
    } catch (e) {
        return errorResult('Failed to probe foundation status', e);
    }
}

/**
 * handle_model_health — the live model registry ranked best-first:
 * which selectors are OK/flaky/rate-limited, with latencies.
 */
export async function handleModelHealth(args: unknown): Promise<ServerResult> {
    ModelHealthArgsSchema.parse(args);
    try {
        const registry = await readModelRegistry();
        if (registry.models.length === 0) {
            return jsonResult({ generated: registry.generated, models: [], note: 'registry empty or missing — run model-health.py' });
        }
        const ranked = [...registry.models].sort((a, b) => {
            const ra = STATUS_RANK[a.status] ?? 9;
            const rb = STATUS_RANK[b.status] ?? 9;
            if (ra !== rb) return ra - rb;
            return (a.latency_ms ?? 99999) - (b.latency_ms ?? 99999);
        });
        return jsonResult({ generated: registry.generated, alive: ranked.filter((m) => m.status === 'ok').length, total: ranked.length, models: ranked });
    } catch (e) {
        return errorResult('Failed to read model health registry', e);
    }
}

/**
 * handle_hindsight_status — full /health response from the Hindsight memory
 * API including db pool state, embeddings engine, reranker mode.
 */
export async function handleHindsightStatus(args: unknown): Promise<ServerResult> {
    HindsightStatusArgsSchema.parse(args);
    try {
        const hs = await httpGet(HEALTH_URL, 5000);
        if (!hs.ok) {
            return jsonResult({ reachable: false, http_ok: hs.ok, detail: hs.detail });
        }
        try {
            const body = JSON.parse(hs.detail) as Record<string, unknown>;
            return jsonResult({ reachable: true, http_ok: true, health: body });
        } catch {
            return jsonResult({ reachable: true, http_ok: true, raw: hs.detail });
        }
    } catch (e) {
        return errorResult('Failed to probe Hindsight', e);
    }
}

/**
 * handle_constitution_check — verify checksum manifest integrity via
 * shasum -a 256 (macOS-native; sha256sum is not present on this platform).
 */
export async function handleConstitutionCheck(args: unknown): Promise<ServerResult> {
    ConstitutionCheckArgsSchema.parse(args);
    try {
        if (!(await fileExists(CONSTITUTION_MANIFEST))) {
            return jsonResult({ present: false, integrity: 'no manifest', manifest: CONSTITUTION_MANIFEST });
        }
        // macOS: shasum -a 256 -c <manifest>. GNU coreutils' sha256sum is not installed.
        const { stdout, stderr } = await execAsync(
            `cd "${OMP_AGENT}" && shasum -a 256 -c .constitution.sha256 2>&1 | head -20 || true`,
        );
        const output = `${stdout}${stderr}`;
        const failed = output.split('\n').filter((l) => l.includes('FAILED'));
        const ok = output.split('\n').filter((l) => l.includes('OK'));
        return jsonResult({
            present: true,
            integrity: failed.length === 0 && ok.length > 0 ? 'VERIFIED' : 'CHECK FAILED',
            checked: ok.length,
            failed,
            manifest: CONSTITUTION_MANIFEST,
        });
    } catch (e) {
        return errorResult('Failed to verify constitution', e);
    }
}

/**
 * handleFoundationAssert — the mechanical read-back gate. Evaluates a
 * declarative claim against live state through a path independent of whatever
 * wrote that state, and returns PASS / FAIL / UNVERIFIED with evidence.
 * Never silent: an unreadable target or malformed pattern is UNVERIFIED, not PASS.
 */
export async function handleFoundationAssert(args: unknown): Promise<ServerResult> {
    const parsed = FoundationAssertArgsSchema.parse(args);
    const target = parsed.target.startsWith('~')
        ? path.join(HOME, parsed.target.slice(1))
        : parsed.target;
    try {
        if (!(await fileExists(target))) {
            return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: 'target does not exist' });
        }

        if (parsed.type === 'file_contains') {
            if (!parsed.pattern) {
                return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: 'pattern required for file_contains' });
            }
            const body = await fs.readFile(target, 'utf8');
            const lines = body.split('\n');
            const isRegex = parsed.pattern.length > 2 && parsed.pattern.startsWith('/') && parsed.pattern.endsWith('/');
            if (!isRegex && /[\^$]/.test(parsed.pattern)) {
                // Ambiguous: unanchored pattern containing regex anchors would be
                // a literal miss presented as FAIL — refuse to guess (false-alarm
                // discipline). Force the caller to be explicit.
                return jsonResult({
                    verdict: 'UNVERIFIED',
                    claim: parsed.type,
                    target,
                    pattern: parsed.pattern,
                    reason: 'pattern contains regex anchors but is not slash-wrapped; use /.../ for regex, or drop ^ $ for literal',
                });
            }
            let matched: string[] = [];
            if (isRegex) {
                let re: RegExp;
                try { re = new RegExp(parsed.pattern.slice(1, -1)); }
                catch (e) { return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: `invalid regex: ${errorMessage(e)}` }); }
                matched = lines.filter((l) => re.test(l));
            } else {
                matched = lines.filter((l) => l.includes(parsed.pattern as string));
            }
            return jsonResult({
                verdict: matched.length > 0 ? 'PASS' : 'FAIL',
                claim: parsed.type,
                target,
                pattern: parsed.pattern,
                matches: matched.length,
                evidence: matched.slice(0, 5).map((l) => l.trim().slice(0, 160)),
            });
        }

        if (parsed.type === 'config_subset') {
            if (!parsed.key || !parsed.allowed) {
                return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: 'key and allowed[] required for config_subset' });
            }
            const body = await fs.readFile(target, 'utf8');
            // Collect indented values directly under `key:` (works for modelRoles-style blocks).
            const lines = body.split('\n');
            const keyIdx = lines.findIndex((l) => new RegExp(`^\\s*${parsed.key as string}:\\s*$`).test(l) || l.trim() === `${parsed.key}:`);
            if (keyIdx === -1) {
                return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: `key '${parsed.key}' not found` });
            }
            const baseIndent = (lines[keyIdx].match(/^\s*/) as RegExpMatchArray)[0].length;
            const values: string[] = [];
            for (let i = keyIdx + 1; i < lines.length; i++) {
                const l = lines[i];
                if (l.trim() === '') continue;
                const indent = (l.match(/^\s*/) as RegExpMatchArray)[0].length;
                if (indent <= baseIndent) break;
                // value = everything after the first "key:" prefix of the line
                const m = l.trim().match(/^[^:]+:\s*(.*)$/);
                const v = m ? m[1] : l.trim();
                if (v !== '') values.push(v);
            }
            if (values.length === 0) {
                return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target, reason: `key '${parsed.key}' has no values` });
            }
            const allowed = new Set(parsed.allowed);
            const offenders = values.filter((v) => !allowed.has(v));
            return jsonResult({
                verdict: offenders.length === 0 ? 'PASS' : 'FAIL',
                claim: parsed.type,
                target,
                key: parsed.key,
                values,
                offenders,
                allowed: parsed.allowed,
            });
        }

        // checksum_verify — manifest path (absolute, or relative to OMP_AGENT).
        const manifest = path.isAbsolute(parsed.target) ? parsed.target : path.join(OMP_AGENT, parsed.target);
        if (!(await fileExists(manifest))) {
            return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target: manifest, reason: 'manifest does not exist' });
        }
        const { stdout, stderr } = await execAsync(
            `cd "${path.dirname(manifest)}" && shasum -a 256 -c "${manifest}" 2>&1 | head -30 || true`,
        );
        const output = `${stdout}${stderr}`;
        const failed = output.split('\n').filter((l) => l.includes('FAILED'));
        const ok = output.split('\n').filter((l) => l.includes('OK'));
        if (ok.length === 0 && failed.length === 0) {
            return jsonResult({ verdict: 'UNVERIFIED', claim: parsed.type, target: manifest, reason: 'manifest produced no OK/FAILED lines', raw: output.slice(0, 300) });
        }
        return jsonResult({
            verdict: failed.length === 0 ? 'PASS' : 'FAIL',
            claim: parsed.type,
            target: manifest,
            checked: ok.length,
            failed,
        });
    } catch (e) {
        return errorResult('foundation_assert failed', e);
    }
}
