// =====================================================================
// AI TÀI XỈU SUNWIN PRO v11.0 - API-ONLY PATTERN LEARNING
// Chỉ cần: server.js + package.json
// KHÔNG đọc file .txt — học cầu 100% từ API lịch sử
// =====================================================================

import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import fs from "node:fs";

// =====================================================================
// CẤU HÌNH
// =====================================================================
const PORT = process.env.PORT || 3000;
const API_URL = "https://apisunwin-cocalhahaha.onrender.com/api/sunwin";
const PATTERN_FILE_URL = "https://raw.githubusercontent.com/huyhuyhu380-cell/ooocs/main/10kmaucau.txt";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================
// GLOBAL STATE
// =====================================================================
let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;
let PATTERN_DB = [];
let LEARNED_PATTERNS = {};
let STATS_FROM_DATA = null;

// =====================================================================
// STATS FALLBACK
// =====================================================================
const STATS = {
    STREAK_BREAK_PROB: {
        1: 0.51, 2: 0.48, 3: 0.52, 4: 0.58, 5: 0.66, 6: 0.74,
        7: 0.81, 8: 0.87, 9: 0.92, 10: 0.95, 11: 0.97, 12: 0.99
    }
};

// =====================================================================
// UTILITIES
// =====================================================================
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function avg(a) { return a.length ? sum(a) / a.length : 0; }
function stdDev(a) {
    if (a.length < 2) return 0;
    const m = avg(a);
    return Math.sqrt(avg(a.map(n => (n - m) ** 2)));
}
function entropy(arr) {
    if (!arr.length) return 0;
    const f = {};
    for (const v of arr) f[v] = (f[v] || 0) + 1;
    let e = 0;
    for (const k in f) { const p = f[k] / arr.length; e -= p * Math.log2(p); }
    return e;
}
function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) m++;
    return m / a.length;
}

// =====================================================================
// PARSE API DATA
// =====================================================================
function parseLines(data) {
    if (!Array.isArray(data)) return [];
    const arr = data.map(item => {
        const session = Number(item.phien ?? 0);
        const dice = Array.isArray(item.xuc_xac) ? item.xuc_xac : [];
        const total = Number(item.Tong ?? item.tong ?? 0);
        const result = item.ket_qua ?? (total >= 11 ? 'Tài' : 'Xỉu');
        const tx = result === 'Tài' ? 'T' : 'X';
        return { session, dice, total, result, tx };
    });
    return arr.filter(r => r.session > 0).sort((a, b) => a.session - b.session);
}

// =====================================================================
// FEATURE EXTRACTION
// =====================================================================
function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push({ val: cur, len }); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push({ val: cur, len });

    return {
        tx, totals, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        avgRunLength: avg(runs.map(r => r.len)),
        meanTotal: avg(totals),
        volatility: stdDev(totals),
        entropy: entropy(tx),
        lastRun: runs[runs.length - 1],
        mean5: avg(totals.slice(-5)),
        mean20: avg(totals.slice(-20))
    };
}
// =====================================================================
// ĐỌC 10K MẪU CẦU TỪ GITHUB (duy nhất nguồn ngoài, không phải .txt local)
// =====================================================================
async function fetchPatternFile(url) {
    try {
        console.log("📥 Đang tải 10k mẫu cầu từ GitHub...");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const patterns = parsePatternText(text);
        console.log(`✅ Đã load ${patterns.length} mẫu cầu GitHub`);
        return patterns;
    } catch (e) {
        console.error("❌ Lỗi tải mẫu cầu:", e.message);
        return [];
    }
}

function parsePatternText(text) {
    const lines = text.split("\n");
    const patterns = [];
    for (const line of lines) {
        const m = line.match(/^\s*\d+\.\s*([TX]+)\s*-\s*([TX])\s*$/);
        if (m) patterns.push({ seq: m[1], next: m[2], len: m[1].length });
    }
    return patterns;
}

// =====================================================================
// HỌC MẪU CẦU TỪ LỊCH SỬ API
// =====================================================================
function learnPatternsFromHistory(history) {
    if (history.length < 20) return {};
    const tx = history.map(h => h.tx);
    const learned = {};
    for (let len = 3; len <= Math.min(15, tx.length - 1); len++) {
        for (let i = 0; i <= tx.length - len - 1; i++) {
            const seq = tx.slice(i, i + len).join('');
            const next = tx[i + len];
            if (!learned[seq]) learned[seq] = { T: 0, X: 0, len };
            learned[seq][next]++;
        }
    }
    return learned;
}

function updateLearnedPatterns(history, newTx) {
    const tx = history.map(h => h.tx);
    const maxLen = Math.min(15, tx.length);
    for (let len = 3; len <= maxLen; len++) {
        const seq = tx.slice(-len).join('');
        if (!LEARNED_PATTERNS[seq]) LEARNED_PATTERNS[seq] = { T: 0, X: 0, len };
        LEARNED_PATTERNS[seq][newTx]++;
    }
}

// =====================================================================
// TÍNH STATS TỪ LỊCH SỬ API
// =====================================================================
function computeStatsFromData(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    const tCount = tx.filter(x => x === 'T').length;

    const scoreFreq = {};
    for (const s of totals) scoreFreq[s] = (scoreFreq[s] || 0) + 1;
    const scoreDist = {};
    for (const s in scoreFreq) scoreDist[s] = scoreFreq[s] / totals.length;

    const runs = [];
    let cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push(len); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push(len);

    const breakProbs = {};
    for (let L = 1; L <= 12; L++) {
        let broke = 0, total = 0, s = 1;
        for (let i = 1; i < tx.length; i++) {
            if (tx[i] === tx[i - 1]) s++;
            else { if (s >= L) total++; if (s === L) broke++; s = 1; }
        }
        if (s >= L) total++;
        if (total > 5) breakProbs[L] = broke / total;
    }

    let tToX = 0, tTot = 0, xToT = 0, xTot = 0;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i - 1] === 'T') { tTot++; if (tx[i] === 'X') tToX++; }
        else { xTot++; if (tx[i] === 'T') xToT++; }
    }

    return {
        sampleSize: history.length,
        tRatio: tCount / tx.length,
        avgScore: avg(totals),
        scoreDist,
        breakProbs,
        markovTtoX: tTot > 0 ? tToX / tTot : 0.5,
        markovXtoT: xTot > 0 ? xToT / xTot : 0.5
    };
}
// =====================================================================
// NHÓM HỌC TỪ LỊCH SỬ API (W/X/Y/Z)
// =====================================================================
function algoW_LearnedExact(history) {
    const keys = Object.keys(LEARNED_PATTERNS);
    if (keys.length < 50 || history.length < 8) return null;
    const tx = history.map(h => h.tx);
    for (const len of [12, 11, 10, 9, 8, 7, 6, 5]) {
        if (tx.length < len) continue;
        const target = tx.slice(-len).join('');
        const f = LEARNED_PATTERNS[target];
        if (f && (f.T + f.X) >= 2) {
            const total = f.T + f.X;
            const conf = Math.abs(f.T - f.X) / total;
            const adj = conf * Math.min(1, total / 5) * (len / 12);
            if (adj >= 0.35) return f.T > f.X ? 'T' : 'X';
        }
    }
    return null;
}

function algoX_LearnedFuzzy(history) {
    if (Object.keys(LEARNED_PATTERNS).length < 100 || history.length < 12) return null;
    const tx = history.map(h => h.tx);
    const target = tx.slice(-12).join('');
    let wT = 0, wX = 0, matches = 0;
    for (const seq in LEARNED_PATTERNS) {
        if (seq.length !== 12) continue;
        const sim = similarity(seq, target);
        if (sim >= 0.75) {
            const p = LEARNED_PATTERNS[seq];
            const w = (sim ** 3) * Math.min(2, p.T + p.X);
            wT += w * p.T; wX += w * p.X; matches++;
        }
    }
    if (matches < 5) return null;
    const total = wT + wX;
    if (!total) return null;
    if (Math.abs(wT - wX) / total >= 0.15) return wT > wX ? 'T' : 'X';
    return null;
}

function algoY_LearnedSuffix(history) {
    if (Object.keys(LEARNED_PATTERNS).length < 50 || history.length < 5) return null;
    const tx = history.map(h => h.tx);
    let bestPred = null, bestScore = 0;
    for (const L of [7, 6, 5, 4]) {
        if (tx.length < L) continue;
        const suffix = tx.slice(-L).join('');
        let tC = 0, xC = 0, total = 0;
        for (const seq in LEARNED_PATTERNS) {
            if (seq.endsWith(suffix)) {
                const p = LEARNED_PATTERNS[seq];
                tC += p.T; xC += p.X; total += p.T + p.X;
            }
        }
        if (total < 3) continue;
        const conf = Math.abs(tC - xC) / total;
        const score = conf * Math.min(1, total / 15) * (L / 7);
        if (score > bestScore && conf >= 0.35) {
            bestScore = score; bestPred = tC > xC ? 'T' : 'X';
        }
    }
    return bestPred;
}

function algoZ_AdaptiveMarkov(history) {
    if (history.length < 40) return null;
    const tx = history.map(h => h.tx);
    const scores = {};
    for (const order of [2, 3, 4, 5]) {
        if (tx.length < order + 30) continue;
        let correct = 0, total = 0;
        for (let i = tx.length - 30; i < tx.length; i++) {
            if (i < order + 5) continue;
            const key = tx.slice(i - order, i).join('');
            let tC = 0, xC = 0;
            for (let j = 0; j < i - 1; j++) {
                if (tx.slice(j, j + order).join('') === key) {
                    if (tx[j + order] === 'T') tC++; else xC++;
                }
            }
            if (tC + xC >= 2) {
                if ((tC > xC ? 'T' : 'X') === tx[i]) correct++;
                total++;
            }
        }
        if (total >= 5) scores[order] = correct / total;
    }
    let bestOrder = 3, bestAcc = 0;
    for (const o in scores) if (scores[o] > bestAcc) { bestAcc = scores[o]; bestOrder = +o; }
    if (bestAcc < 0.55) return null;
    const key = tx.slice(-bestOrder).join('');
    let tC = 0, xC = 0;
    for (let j = 0; j < tx.length - bestOrder; j++) {
        if (tx.slice(j, j + bestOrder).join('') === key) {
            if (tx[j + bestOrder] === 'T') tC++; else xC++;
        }
    }
    if (tC + xC < 3) return null;
    if (Math.abs(tC - xC) / (tC + xC) >= 0.2) return tC > xC ? 'T' : 'X';
    return null;
}

// =====================================================================
// NHÓM PATTERN DB GITHUB (R/T/U/V)
// =====================================================================
function algoR_Exact(history) {
    if (!PATTERN_DB.length || history.length < 8) return null;
    const tx = history.map(h => h.tx);
    for (const len of [15, 14, 13, 12, 11, 10, 9, 8]) {
        if (tx.length < len) continue;
        const target = tx.slice(-len).join('');
        const matches = PATTERN_DB.filter(p => p.seq === target);
        if (matches.length >= 2) {
            const t = matches.filter(m => m.next === 'T').length;
            const x = matches.filter(m => m.next === 'X').length;
            if (Math.abs(t - x) / matches.length >= 0.5) return t > x ? 'T' : 'X';
        }
    }
    return null;
}

function algoT_Fuzzy(history) {
    if (!PATTERN_DB.length || history.length < 15) return null;
    const target = history.map(h => h.tx).slice(-15).join('');
    let wT = 0, wX = 0, n = 0;
    for (const p of PATTERN_DB) {
        if (p.seq.length !== 15) continue;
        let m = 0;
        for (let i = 0; i < 15; i++) if (p.seq[i] === target[i]) m++;
        const score = m / 15;
        if (score >= 0.8) {
            if (p.next === 'T') wT += score * score;
            else wX += score * score;
            n++;
        }
    }
    if (n < 5) return null;
    const total = wT + wX;
    if (!total) return null;
    if (Math.abs(wT - wX) / total >= 0.15) return wT > wX ? 'T' : 'X';
    return null;
}

function algoU_Suffix(history) {
    if (!PATTERN_DB.length || history.length < 6) return null;
    const tx = history.map(h => h.tx);
    let bestPred = null, bestScore = 0;
    for (const L of [7, 6, 5, 4, 3]) {
        if (tx.length < L) continue;
        const suffix = tx.slice(-L).join('');
        const matches = PATTERN_DB.filter(p => p.seq.endsWith(suffix));
        if (matches.length < 3) continue;
        const t = matches.filter(m => m.next === 'T').length;
        const x = matches.length - t;
        const conf = Math.abs(t - x) / matches.length;
        const score = conf * Math.min(1, matches.length / 20) * (L / 7);
        if (score > bestScore && conf >= 0.4) {
            bestScore = score; bestPred = t > x ? 'T' : 'X';
        }
    }
    return bestPred;
}

function algoV_Similarity(history) {
    if (!PATTERN_DB.length || history.length < 15) return null;
    const target = history.map(h => h.tx).slice(-15).join('');
    let wT = 0, wX = 0;
    const sample = PATTERN_DB.length > 5000 ? PATTERN_DB.filter((_, i) => i % 2 === 0) : PATTERN_DB;
    for (const p of sample) {
        const sim = similarity(p.seq, target);
        if (sim >= 0.65) {
            if (p.next === 'T') wT += sim ** 3;
            else wX += sim ** 3;
        }
    }
    const total = wT + wX;
    if (total < 2) return null;
    if (Math.abs(wT - wX) / total >= 0.2) return wT > wX ? 'T' : 'X';
    return null;
}
function algoA_Markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    const maxOrder = history.length < 30 ? 3 : 5;
    let bestPred = null, bestScore = -1;
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        const trans = {};
        const totalT = tx.length - order;
        for (let i = 0; i < totalT; i++) {
            const key = tx.slice(i, i + order).join('');
            const w = Math.pow(0.95, totalT - i - 1);
            if (!trans[key]) trans[key] = { T: 0, X: 0 };
            trans[key][tx[i + order]] += w;
        }
        const c = trans[tx.slice(-order).join('')];
        if (c && (c.T + c.X) > 0.5) {
            const conf = Math.abs(c.T - c.X) / (c.T + c.X);
            const score = conf * (order / maxOrder) * Math.min(1, (c.T + c.X) / 10);
            if (score > bestScore) { bestScore = score; bestPred = c.T > c.X ? 'T' : 'X'; }
        }
    }
    return bestPred;
}

function algoB_Ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    let bestPred = null, bestConf = 0;
    for (const n of [7, 6, 5, 4, 3]) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        const matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            if (tx.slice(i, i + n).join('') === target) {
                matches.push({ next: tx[i + n], dist: tx.length - i });
            }
        }
        if (matches.length >= 2) {
            let wT = 0, wX = 0, tw = 0;
            for (const m of matches) {
                const wt = 1 / (m.dist * 0.5 + 1);
                if (m.next === 'T') wT += wt; else wX += wt;
                tw += wt;
            }
            if (tw > 0) {
                const conf = Math.abs(wT - wX) / tw;
                if (conf > bestConf) { bestConf = conf; bestPred = wT > wX ? 'T' : 'X'; }
            }
        }
    }
    return bestConf > 0.3 ? bestPred : null;
}

function algoG_SuperBridge(history) {
    const f = extractFeatures(history);
    if (f.runs.length < 4) return null;
    const last = f.runs[f.runs.length - 1];
    const avgRun = avg(f.runs.map(r => r.len));
    if (last.len >= 10) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 8) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 7 && last.len > avgRun * 2) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 5 && last.len > avgRun * 1.8) return last.val === 'T' ? 'X' : 'T';
    return null;
}

function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const votes = { T: 0, X: 0 };
    for (const order of [2, 3, 4, 5]) {
        if (tx.length < order + 5) continue;
        const trans = {};
        for (let i = 0; i <= tx.length - order - 1; i++) {
            const key = tx.slice(i, i + order).join('');
            if (!trans[key]) trans[key] = { T: 0, X: 0 };
            trans[key][tx[i + order]]++;
        }
        const c = trans[tx.slice(-order).join('')];
        if (c && c.T + c.X >= 2) {
            const conf = Math.abs(c.T - c.X) / (c.T + c.X);
            votes[c.T > c.X ? 'T' : 'X'] += conf * (order / 10);
        }
    }
    return (votes.T + votes.X) > 0.3 ? (votes.T > votes.X ? 'T' : 'X') : null;
}

function algoI_PatternMaster(history) {
    if (history.length < 25) return null;
    const f = extractFeatures(history);
    if (f.runs.length < 5) return null;
    const recent = f.runs.slice(-8);
    const runPattern = recent.map(r => r.len).join('');
    const lastVal = recent[recent.length - 1].val;
    const strength = { T: 0, X: 0 };

    const runLib = [
        { p: '12121', pred: lastVal === 'T' ? 'X' : 'T', s: 0.72 },
        { p: '21212', pred: lastVal === 'T' ? 'T' : 'X', s: 0.72 },
        { p: '121212', pred: lastVal === 'T' ? 'X' : 'T', s: 0.78 },
        { p: '212121', pred: lastVal === 'T' ? 'T' : 'X', s: 0.78 }
    ];
    for (const l of runLib) if (runPattern.includes(l.p)) strength[l.pred] += l.s;

    const last10 = f.tx.slice(-10).join('');
    const txLib = [
        { p: 'TXTXTXTX', pred: 'X', s: 0.82 },
        { p: 'XTXTXTXT', pred: 'T', s: 0.82 },
        { p: 'TTXXTTXX', pred: 'X', s: 0.72 },
        { p: 'XXTTXXTT', pred: 'T', s: 0.72 }
    ];
    for (const p of txLib) if (last10.includes(p.p)) strength[p.pred] += p.s;

    const total = strength.T + strength.X;
    if (total > 0 && Math.abs(strength.T - strength.X) / total > 0.25) {
        return strength.T > strength.X ? 'T' : 'X';
    }
    return null;
}

function algoQ_StreakProbability(history) {
    if (history.length < 15) return null;
    const f = extractFeatures(history);
    const last = f.runs[f.runs.length - 1];
    if (!last) return null;
    let bp = null;
    if (STATS_FROM_DATA?.breakProbs) {
        const learned = STATS_FROM_DATA.breakProbs[Math.min(last.len, 12)];
        if (learned !== undefined) bp = learned;
    }
    if (bp === null) {
        bp = STATS.STREAK_BREAK_PROB[Math.min(last.len, 12)] || 0.99;
    }
    if (bp > 0.6) return last.val === 'T' ? 'X' : 'T';
    if (bp < 0.4) return last.val;
    return null;
}

function algoN_Transition(history) {
    if (history.length < 30) return null;
    const recent = history.map(h => h.tx).slice(-50);
    const t = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < recent.length; i++) t[recent[i - 1] + recent[i]]++;
    const last = recent[recent.length - 1];
    const tot = last === 'T' ? t.TT + t.TX : t.XT + t.XX;
    if (tot < 5) return null;
    const flip = last === 'T' ? t.TX / tot : t.XT / tot;
    if (flip > 0.55) return last === 'T' ? 'X' : 'T';
    if (flip < 0.45) return last;
    return null;
}

function algoL_Momentum(history) {
    if (history.length < 30) return null;
    const totals = history.map(h => h.total);
    const m5 = avg(totals.slice(-5));
    const m20 = avg(totals.slice(-20));
    if (m5 > 12.5) return 'X';
    if (m5 < 8.5) return 'T';
    if (m5 > m20 + 2) return 'X';
    if (m5 < m20 - 2) return 'T';
    return null;
}
// =====================================================================
// DANH SÁCH THUẬT TOÁN
// =====================================================================
const ALL_ALGS = [
    { id: 'W_learned_exact',   fn: algoW_LearnedExact,   group: 'learned',    baseWeight: 3.5 },
    { id: 'X_learned_fuzzy',   fn: algoX_LearnedFuzzy,   group: 'learned',    baseWeight: 3.0 },
    { id: 'Y_learned_suffix',  fn: algoY_LearnedSuffix,  group: 'learned',    baseWeight: 2.5 },
    { id: 'Z_adaptive_markov', fn: algoZ_AdaptiveMarkov, group: 'learned',    baseWeight: 2.0 },
    { id: 'R_exact_db',        fn: algoR_Exact,          group: 'pattern_db', baseWeight: 3.0 },
    { id: 'T_fuzzy_db',        fn: algoT_Fuzzy,          group: 'pattern_db', baseWeight: 2.5 },
    { id: 'U_suffix_db',       fn: algoU_Suffix,         group: 'pattern_db', baseWeight: 2.0 },
    { id: 'V_similarity_db',   fn: algoV_Similarity,     group: 'pattern_db', baseWeight: 1.5 },
    { id: 'A_markov',          fn: algoA_Markov,         group: 'follow',     baseWeight: 1.0 },
    { id: 'B_ngram',           fn: algoB_Ngram,          group: 'follow',     baseWeight: 1.0 },
    { id: 'I_pattern_master',  fn: algoI_PatternMaster,  group: 'follow',     baseWeight: 1.0 },
    { id: 'G_super_bridge',    fn: algoG_SuperBridge,    group: 'reverse',    baseWeight: 1.0 },
    { id: 'L_momentum',        fn: algoL_Momentum,       group: 'reverse',    baseWeight: 1.0 },
    { id: 'Q_streak',          fn: algoQ_StreakProbability, group: 'reverse', baseWeight: 1.0 },
    { id: 'H_adaptive_markov', fn: algoH_AdaptiveMarkov, group: 'neutral',    baseWeight: 1.0 },
    { id: 'N_transition',      fn: algoN_Transition,     group: 'neutral',    baseWeight: 1.0 }
];

// =====================================================================
// ENSEMBLE
// =====================================================================
class Ensemble {
    constructor() {
        this.weights = {};
        this.perAlgoStats = {};
        this.recentPreds = [];
        this.recentActuals = [];
        for (const a of ALL_ALGS) {
            this.weights[a.id] = a.baseWeight;
            this.perAlgoStats[a.id] = { correct: 0, total: 0 };
        }
        this._normalize();
    }
    _normalize() {
        const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (total > 0) for (const id in this.weights) this.weights[id] /= total;
    }
    updateWeights(historyPrefix, actualTx) {
        for (const a of ALL_ALGS) {
            try {
                const pred = a.fn(historyPrefix);
                if (!pred) continue;
                const correct = pred === actualTx;
                this.perAlgoStats[a.id].total++;
                if (correct) this.perAlgoStats[a.id].correct++;
                let lr = 0.02;
                if (a.group === 'learned') lr = 0.08;
                else if (a.group === 'pattern_db') lr = 0.05;
                else if (a.group === 'follow' || a.group === 'reverse') lr = 0.03;
                const w = this.weights[a.id];
                this.weights[a.id] = Math.max(0.005, Math.min(5, correct ? w * (1 + lr) : w * (1 - lr)));
            } catch (e) { /* skip */ }
        }
        this._normalize();
    }
    rebalance() {
        for (const a of ALL_ALGS) {
            const s = this.perAlgoStats[a.id];
            if (s.total < 10) continue;
            const wr = s.correct / s.total;
            this.weights[a.id] *= Math.max(0.5, Math.min(2, 1 + (wr - 0.5) * 1.5));
            this.weights[a.id] = Math.max(0.005, Math.min(5, this.weights[a.id]));
        }
        this._normalize();
    }
    predict(history) {
        if (history.length < 12) {
            const t = history.filter(h => h.tx === 'T').length;
            const x = history.length - t;
            return { prediction: t > x ? 'X' : 'T', confidence: 0.5, details: [] };
        }
        const votes = { T: 0, X: 0 };
        const details = [];
        for (const a of ALL_ALGS) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                const w = this.weights[a.id];
                votes[pred] += w;
                details.push({ algo: a.id, pred, w: +w.toFixed(4), group: a.group });
            } catch (e) { /* skip */ }
        }
        const total = votes.T + votes.X;
        if (total === 0) return { prediction: 'T', confidence: 0.5, details };
        const best = votes.T > votes.X ? 'T' : 'X';
        const confidence = Math.min(0.95, Math.max(0.55, Math.max(votes.T, votes.X) / total));

        const last4 = this.recentPreds.slice(-4);
        if (last4.length === 4 && last4.every(p => p === best)) {
            const actuals = this.recentActuals.slice(-4);
            const wrong = last4.filter((p, i) => p !== actuals[i]).length;
            if (wrong >= 3) return { prediction: best === 'T' ? 'X' : 'T', confidence: 0.6, details };
        }
        return { prediction: best, confidence, details };
    }
    recordActual(tx) {
        this.recentActuals.push(tx);
        if (this.recentActuals.length > 20) this.recentActuals.shift();
    }
    recordPrediction(tx) {
        this.recentPreds.push(tx);
        if (this.recentPreds.length > 20) this.recentPreds.shift();
    }
}

// =====================================================================
// MANAGER
// =====================================================================
class PatternManager {
    constructor() {
        this.history = [];
        this.ensemble = new Ensemble();
        this.currentPrediction = null;
        this.sinceRebalance = 0;
        this.predictionLog = {};
    }
    init(history) {
        this.history = [...history];
        LEARNED_PATTERNS = learnPatternsFromHistory(this.history);
        STATS_FROM_DATA = computeStatsFromData(this.history);
        this.currentPrediction = this.ensemble.predict(this.history);
        console.log(`🧠 Học ${Object.keys(LEARNED_PATTERNS).length} mẫu từ ${this.history.length} phiên API`);
        console.log(`🔮 Dự đoán ${this.history.at(-1).session + 1}: ${this.currentPrediction.prediction}`);
    }
    push(record) {
        if (this.currentPrediction) {
            this.predictionLog[record.session] = {
                pred: this.currentPrediction.prediction,
                conf: this.currentPrediction.confidence
            };
            this.ensemble.recordPrediction(this.currentPrediction.prediction);
        }
        this.ensemble.recordActual(record.tx);
        const prefix = this.history.slice();
        if (prefix.length >= 10) this.ensemble.updateWeights(prefix, record.tx);
        updateLearnedPatterns(this.history, record.tx);
        this.history.push(record);
        if (this.history.length > 500) this.history = this.history.slice(-450);

        this.sinceRebalance++;
        if (this.sinceRebalance >= 20) {
            this.ensemble.rebalance();
            this.sinceRebalance = 0;
            STATS_FROM_DATA = computeStatsFromData(this.history);
        }
        this.currentPrediction = this.ensemble.predict(this.history);
    }
}

const manager = new PatternManager();

// =====================================================================
// FETCH API
// =====================================================================
async function fetchAndProcessHistory() {
    try {
        const res = await fetch(API_URL);
        const data = await res.json();
        const newHistory = parseLines(data);
        if (newHistory.length === 0) return;

        const last = newHistory.at(-1);
        if (!currentSessionId) {
            manager.init(newHistory);
            txHistory = newHistory;
            currentSessionId = last.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên API`);
        } else if (last.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            for (const r of newRecords) {
                manager.push(r);
                txHistory.push(r);
            }
            if (txHistory.length > 350) txHistory = txHistory.slice(-300);
            currentSessionId = last.session;
            if (newRecords.length > 0) console.log(`🆕 +${newRecords.length} phiên → ${currentSessionId}`);
        }
    } catch (e) {
        console.error("❌ Lỗi fetch:", e.message);
    }
}

// =====================================================================
// FASTIFY SERVER
// =====================================================================
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

app.get("/api/sunwin/tx", async () => {
    const last = txHistory.at(-1);
    const p = manager.currentPrediction;
    if (!last || !p) return {
        id: "@cskhgiabao", phien_truoc: null, xuc_xac: null,
        ket_qua: "đang chờ...", phien_nay: null, du_doan: "chưa có", do_tin_cay: "0%"
    };
    return {
        id: "@cskhgiabao",
        phien_truoc: last.session,
        xuc_xac: last.dice,
        ket_qua: last.result.toLowerCase(),
        phien_nay: last.session + 1,
        du_doan: p.prediction === 'T' ? 'tài' : 'xỉu',
        do_tin_cay: `${(p.confidence * 100).toFixed(0)}%`,
        pattern_db_size: PATTERN_DB.length,
        learned_patterns: Object.keys(LEARNED_PATTERNS).length
    };
});

app.get("/api/sunwin/history", async () => {
    if (!txHistory.length) return { message: "chưa có dữ liệu" };
    return [...txHistory].sort((a, b) => b.session - a.session).map(item => {
        const log = manager.predictionLog[item.session];
        let nhan_xet = "—";
        if (log) {
            const dung = log.pred === item.tx;
            nhan_xet = dung
                ? `✅ Đúng (${log.pred === 'T' ? 'tài' : 'xỉu'} ${(log.conf * 100).toFixed(0)}%)`
                : `❌ Sai (${log.pred === 'T' ? 'tài' : 'xỉu'} ${(log.conf * 100).toFixed(0)}%)`;
        }
        return {
            session: item.session, dice: item.dice, total: item.total,
            result: item.result.toLowerCase(), tx_label: item.tx.toLowerCase(), nhan_xet
        };
    });
});

app.get("/api/balance/stats", async () => {
    const algoPerf = {};
    for (const a of ALL_ALGS) {
        const s = manager.ensemble.perAlgoStats[a.id];
        algoPerf[a.id] = {
            group: a.group,
            weight: +manager.ensemble.weights[a.id].toFixed(4),
            correct: s.correct, total: s.total,
            winrate: s.total > 0 ? +(s.correct / s.total * 100).toFixed(1) : null
        };
    }
    return {
        pattern_db: { total: PATTERN_DB.length, source: PATTERN_FILE_URL },
        learned_patterns: { total: Object.keys(LEARNED_PATTERNS).length, sample_size: manager.history.length },
        stats: STATS_FROM_DATA,
        algorithms: algoPerf
    };
});

app.get("/xem", async (req, reply) => {
    if (!txHistory.length) return reply.type("text/html").send("<h1>Chưa có dữ liệu</h1>");
    const rev = [...txHistory].sort((a, b) => b.session - a.session).slice(0, 100);
    let total = 0, correct = 0;
    for (const it of rev) {
        const log = manager.predictionLog[it.session];
        if (log) { total++; if (log.pred === it.tx) correct++; }
    }
    const acc = total > 0 ? (correct / total * 100).toFixed(1) : "0.0";
    const rows = rev.map(it => {
        const log = manager.predictionLog[it.session];
        let nx = "—", color = "#888";
        if (log) {
            const d = log.pred === it.tx;
            nx = d ? `✅ Đúng (${(log.conf * 100).toFixed(0)}%)` : `❌ Sai (${(log.conf * 100).toFixed(0)}%)`;
            color = d ? "#00ff88" : "#ff4444";
        }
        const c = it.tx === 'T' ? '#ff6b6b' : '#4ecdc4';
        return `<tr><td>${it.session}</td><td style="color:${c};font-weight:bold">${it.tx === 'T' ? 'TÀI' : 'XỈU'}</td><td>${it.total}</td><td style="color:${color};font-weight:bold">${nx}</td></tr>`;
    }).join("");
    const p = manager.currentPrediction;
    const next = txHistory.at(-1).session + 1;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>AI Tài Xỉu v11</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0e1a;color:#e0e0e0;font-family:-apple-system,sans-serif;padding:12px}h1{font-size:18px;margin-bottom:8px;color:#ffd700}.box{background:linear-gradient(135deg,#1e3a5f,#2d1b4e);padding:14px;border-radius:8px;margin-bottom:12px;border:1px solid #ffd700}.pred{font-size:24px;font-weight:bold;color:#ffd700;text-transform:uppercase}.stats{background:#1a1f2e;padding:12px;border-radius:8px;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap;font-size:13px}.stats b{color:#ffd700}table{width:100%;border-collapse:collapse;background:#1a1f2e;border-radius:8px;overflow:hidden;font-size:13px}th{background:#252b3d;padding:10px 8px;text-align:left;color:#ffd700}td{padding:10px 8px;border-top:1px solid #252b3d}</style></head>
<body><h1>🎲 AI Tài Xỉu Sunwin v11</h1>
<div class="box"><h2>🔮 Dự đoán phiên ${next}</h2><div class="pred">${p ? (p.prediction === 'T' ? 'TÀI' : 'XỈU') : 'chờ'}</div>
<div style="color:#aaa;margin-top:4px">Tin cậy: ${p ? (p.confidence * 100).toFixed(0) : 0}% | Pattern DB: ${PATTERN_DB.length} | Học: ${Object.keys(LEARNED_PATTERNS).length}</div></div>
<div class="stats"><span>Tổng: <b>${total}</b></span><span>Đúng: <b style="color:#00ff88">${correct}</b></span><span>Sai: <b style="color:#ff4444">${total - correct}</b></span><span>Tỷ lệ: <b>${acc}%</b></span></div>
<table><thead><tr><th>Phiên</th><th>KQ</th><th>Tổng</th><th>Nhận xét</th></tr></thead><tbody>${rows}</tbody></table>
<div style="text-align:center;color:#666;font-size:11px;margin-top:12px">Cập nhật mỗi 10s • ${new Date().toLocaleString('vi-VN')}</div>
</body></html>`;
    reply.type("text/html").send(html);
});

app.get("/", async () => ({
    status: "ok", msg: "AI Tài Xỉu Sunwin v11 - API Only",
    version: "11.0",
    algorithms: ALL_ALGS.length,
    pattern_db: PATTERN_DB.length,
    learned: Object.keys(LEARNED_PATTERNS).length,
    endpoints: ["/api/sunwin/tx", "/api/sunwin/history", "/api/balance/stats", "/xem"]
}));

// =====================================================================
// START
// =====================================================================
const start = async () => {
    PATTERN_DB = await fetchPatternFile(PATTERN_FILE_URL);
    if (PATTERN_DB.length) console.log(`✅ Pattern DB: ${PATTERN_DB.length} mẫu GitHub`);

    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
    } catch (err) {
        const logFile = path.join(__dirname, "server-error.log");
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] ${err.message}\n${err.stack}\n`, { flag: "a+" });
        console.error(err);
        process.exit(1);
    }

    fetchAndProcessHistory();
    clearInterval(fetchInterval);
    fetchInterval = setInterval(fetchAndProcessHistory, 5000);

    console.log(`\n🚀 AI Tài Xỉu Sunwin v11 - API Only`);
    console.log(`   ➜ http://localhost:${PORT}/`);
    console.log(`   ➜ Pattern DB GitHub: ${PATTERN_DB.length}`);
    console.log(`   ➜ ${ALL_ALGS.length} thuật toán (học từ API, không đọc .txt)\n`);
};

start();