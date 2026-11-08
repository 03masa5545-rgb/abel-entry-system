"use strict";
/* アーベル入退室システム 静的デモ用モックバックエンド
   GitHub Pages などサーバーのない環境で、ブラウザ内だけでデモを動かすためのもの。
   window.fetch を上書きし、/api/ で始まるリクエストだけを横取りする。
   データは localStorage（キー: abel_static_db_v1）に保存され、このブラウザの外に出ない。 */

(function () {
  const DB_KEY = "abel_static_db_v1";
  const ADMIN_ID = "demo-admin";
  const originalFetch = window.fetch.bind(window);

  /* ---------- DB ---------- */
  function defaultDb() {
    return {
      members: [],
      logs: [],
      stays: [],
      settings: { cooldown: 30, autoHours: 12, baseUrl: "", sb: { token: "", secret: "", deviceId: "" } },
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return defaultDb();
      const db = JSON.parse(raw);
      const def = defaultDb();
      db.members = db.members || [];
      db.logs = db.logs || [];
      db.stays = db.stays || [];
      db.settings = Object.assign(def.settings, db.settings || {});
      db.settings.sb = Object.assign(def.settings.sb, (db.settings && db.settings.sb) || {});
      return db;
    } catch (e) {
      return defaultDb();
    }
  }

  function saveDb(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* 保存失敗時は無視 */ }
  }

  /* ---------- 時刻（日本時間 +09:00 の ISO 文字列） ---------- */
  function toJstIso(date) {
    const jst = new Date(date.getTime() + 9 * 3600 * 1000);
    return jst.toISOString().replace(/\.\d{3}Z$/, "+09:00").replace("Z", "+09:00");
  }
  function nowIso() { return toJstIso(new Date()); }
  function parseIso(s) { return new Date(s); }
  function minutesBetween(aIso, bIso) {
    return Math.floor((parseIso(bIso) - parseIso(aIso)) / 60000);
  }
  function todayStr() { return nowIso().slice(0, 10); }

  function periodBounds(period) {
    const now = nowIso();
    const y = Number(now.slice(0, 4));
    const m = Number(now.slice(5, 7));
    const pad = (n) => String(n).padStart(2, "0");
    if (period === "month") return { start: y + "-" + pad(m) + "-01", end: null };
    if (period === "last_month") {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      return { start: ly + "-" + pad(lm) + "-01", end: y + "-" + pad(m) + "-01" };
    }
    return { start: null, end: null };
  }

  /* ---------- 小物 ---------- */
  function randomId(prefix) {
    let s = "";
    const chars = "0123456789abcdef";
    for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return prefix + s;
  }
  function jsonRes(status, obj) {
    return new Response(JSON.stringify(obj), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  }
  function getHeader(headers, name) {
    if (!headers) return null;
    const lower = name.toLowerCase();
    if (typeof headers.get === "function") return headers.get(name);
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (String(pair[0]).toLowerCase() === lower) return pair[1];
      }
      return null;
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return null;
  }
  function memberByLine(db, uid) {
    return db.members.find((m) => m.line_user_id === uid) || null;
  }
  function memberById(db, id) {
    return db.members.find((m) => m.member_id === id) || null;
  }
  function addLog(db, memberId, lineUserId, type, result, method) {
    db.logs.push({
      member_id: memberId || null,
      line_user_id: lineUserId || "",
      type: type,
      result: result,
      method: method || "",
      created_at: nowIso(),
    });
  }
  function openStayOf(db, memberId) {
    const open = db.stays.filter((s) => s.member_id === memberId && s.exit_method === "open");
    open.sort((a, b) => (a.entry_at < b.entry_at ? 1 : -1));
    return open[0] || null;
  }
  function closeStay(stay, exitIso, method) {
    stay.exit_at = exitIso;
    stay.exit_method = method;
    stay.stay_minutes = minutesBetween(stay.entry_at, exitIso);
    return stay.stay_minutes;
  }

  /* 設定時間を超えた open stay を自動退室扱いにする。閉じた件数を返す。 */
  function runAutoExit(db) {
    const hours = Number(db.settings.autoHours) || 12;
    const now = new Date();
    let closed = 0;
    for (const stay of db.stays) {
      if (stay.exit_method !== "open") continue;
      const limit = new Date(parseIso(stay.entry_at).getTime() + hours * 3600 * 1000);
      if (limit <= now) {
        closeStay(stay, toJstIso(limit), "auto");
        const member = memberById(db, stay.member_id);
        addLog(db, stay.member_id, member ? member.line_user_id : "", "auto_exit", "success", "system");
        closed++;
      }
    }
    if (closed) saveDb(db);
    return closed;
  }

  /* ---------- ランキング ---------- */
  function computeRankings(db, period, type) {
    const bounds = periodBounds(period);
    const stats = new Map();
    for (const stay of db.stays) {
      if (bounds.start && stay.entry_at < bounds.start) continue;
      if (bounds.end && stay.entry_at >= bounds.end) continue;
      const member = memberById(db, stay.member_id);
      if (!member || member.status !== "active") continue;
      if (!stats.has(member.member_id)) {
        stats.set(member.member_id, { member_id: member.member_id, name: member.name, count: 0, minutes: 0 });
      }
      const st = stats.get(member.member_id);
      st.count += 1;
      if (stay.exit_method !== "open" && stay.stay_minutes != null) st.minutes += stay.stay_minutes;
    }
    const items = Array.from(stats.values()).filter((i) => i.count > 0);
    const key = type === "duration" ? "minutes" : "count";
    items.sort((a, b) => (b[key] - a[key]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let rank = 0, prev = null;
    items.forEach((item, idx) => {
      if (item[key] !== prev) { rank = idx + 1; prev = item[key]; }
      item.rank = rank;
    });
    return items;
  }

  function myRank(db, memberId) {
    const result = {};
    for (const type of ["count", "duration"]) {
      const items = computeRankings(db, "month", type);
      const key = type === "count" ? "count" : "minutes";
      const mine = items.find((i) => i.member_id === memberId);
      result[type] = mine ? { rank: mine.rank, value: mine[key] } : { rank: null, value: 0 };
    }
    return result;
  }

  /* ---------- 利用歴 ---------- */
  function historyRows(db, filters) {
    const f = filters || {};
    let rows = db.logs.slice();
    if (f.from) rows = rows.filter((l) => l.created_at.slice(0, 10) >= f.from);
    if (f.to) rows = rows.filter((l) => l.created_at.slice(0, 10) <= f.to);
    if (f.member_id) rows = rows.filter((l) => l.member_id === f.member_id);
    if (f.result) rows = rows.filter((l) => l.result === f.result);
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return rows.map((l) => {
      const member = l.member_id ? memberById(db, l.member_id) : null;
      return {
        created_at: l.created_at,
        member_id: l.member_id,
        name: member ? member.name : "",
        type: l.type,
        result: l.result,
        method: l.method || "",
      };
    });
  }

  /* ---------- CSV ---------- */
  const CSV_TYPE_LABELS = { entry: "入室", exit: "退室", auto_exit: "自動退室", unlock_staff: "スタッフ解錠" };
  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvText(lines) {
    return "﻿" + lines.map((cols) => cols.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  }
  function historyCsv(db, filters) {
    const rows = historyRows(db, filters).slice().reverse(); // CSVは時系列（古い順）
    const closed = db.stays.filter((s) => s.exit_method !== "open");
    const used = new Set();
    function findMinutes(row) {
      if (row.type !== "exit" && row.type !== "auto_exit") return "";
      let best = null;
      for (const s of closed) {
        if (s.member_id !== row.member_id || used.has(s.stay_id)) continue;
        if (s.exit_at <= row.created_at || (row.type === "exit" && Math.abs(parseIso(s.exit_at) - parseIso(row.created_at)) <= 5000)) {
          if (!best || s.exit_at > best.exit_at) best = s;
        }
      }
      if (best) { used.add(best.stay_id); return best.stay_minutes; }
      return "";
    }
    const lines = [["日時", "会員ID", "氏名", "種別", "結果", "方法", "滞在時間（分）"]];
    for (const r of rows) {
      lines.push([r.created_at, r.member_id || "", r.name, CSV_TYPE_LABELS[r.type] || r.type, r.result, r.method, findMinutes(r)]);
    }
    return csvText(lines);
  }
  function rankingCsv(db, period, type) {
    const items = computeRankings(db, period, type);
    const lines = [["順位", "会員ID", "氏名", "利用回数", "利用時間（分）"]];
    for (const i of items) lines.push([i.rank, i.member_id, i.name, i.count, i.minutes]);
    return csvText(lines);
  }
  function downloadCsv(filename, text) {
    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* CSVリンク（<a href="/api/admin/*.csv?...">）のクリックを横取りしてダウンロードさせる */
  document.addEventListener("click", function (e) {
    const a = e.target && e.target.closest ? e.target.closest("#histCsvLink, #rankCsvLink") : null;
    if (!a) return;
    e.preventDefault();
    const db = loadDb();
    const params = new URL(a.href, location.href).searchParams;
    if (a.id === "histCsvLink") {
      const filters = {
        from: params.get("from") || null,
        to: params.get("to") || null,
        member_id: params.get("member_id") || null,
        result: params.get("result") || null,
      };
      downloadCsv("abel_usage_" + (filters.from || "all") + "_" + (filters.to || "all") + ".csv", historyCsv(db, filters));
    } else {
      const period = params.get("period") || "month";
      const type = params.get("type") || "count";
      downloadCsv("abel_ranking_" + period + "_" + type + ".csv", rankingCsv(db, period, type));
    }
  }, true);

  /* ---------- SwitchBot 状態 ---------- */
  function switchbotState(db) {
    const sb = db.settings.sb || { token: "", secret: "", deviceId: "" };
    const configured = !!(sb.token && sb.secret && sb.deviceId);
    return {
      configured: configured,
      source: configured ? "db" : null,
      device_id_masked: sb.deviceId ? "****" + sb.deviceId.slice(-4) : "",
      has_token: !!sb.token,
      has_secret: !!sb.secret,
    };
  }

  /* ---------- ルーティング ---------- */
  function handleApi(url, options) {
    const path = url.pathname;
    const method = (options.method || "GET").toUpperCase();
    const uid = getHeader(options.headers, "X-Line-User-Id");
    let body = {};
    if (options.body) {
      try { body = JSON.parse(options.body); } catch (e) { body = {}; }
    }
    const db = loadDb();
    const isAdmin = uid === ADMIN_ID;
    const adminGuard = () => (isAdmin ? null : jsonRes(403, { error: "forbidden", message: "管理者権限が必要です。" }));

    /* --- 共通 --- */
    if (path === "/api/config" && method === "GET") {
      return jsonRes(200, { demoMode: true, liffId: null });
    }

    if (path === "/api/register" && method === "POST") {
      if (!uid) return jsonRes(401, { error: "unauthorized", message: "LINE認証が必要です。" });
      const name = (body.name || "").trim();
      if (!name) return jsonRes(400, { error: "name_required", message: "氏名を入力してください。" });
      let member = memberByLine(db, uid);
      if (member) {
        member.name = name;
      } else {
        member = {
          member_id: randomId("m_"),
          line_user_id: uid,
          name: name,
          status: "active",
          registered_at: nowIso(),
        };
        db.members.push(member);
      }
      saveDb(db);
      return jsonRes(200, {
        member_id: member.member_id, line_user_id: member.line_user_id,
        name: member.name, status: member.status, registered_at: member.registered_at,
      });
    }

    if (path === "/api/me" && method === "GET") {
      runAutoExit(db);
      if (!uid) return jsonRes(401, { error: "unauthorized", message: "LINE認証が必要です。" });
      const member = memberByLine(db, uid);
      if (!member) return jsonRes(200, { member: null, openStay: null, history: [], myRank: null });
      const stay = openStayOf(db, member.member_id);
      const history = db.logs
        .filter((l) => l.member_id === member.member_id)
        .slice().reverse().slice(0, 20)
        .map((l) => ({ type: l.type, result: l.result, created_at: l.created_at }));
      return jsonRes(200, {
        member: {
          member_id: member.member_id, line_user_id: member.line_user_id,
          name: member.name, status: member.status, registered_at: member.registered_at,
        },
        openStay: stay ? { stay_id: stay.stay_id, entry_at: stay.entry_at } : null,
        history: history,
        myRank: myRank(db, member.member_id),
      });
    }

    if (path === "/api/entry" && method === "POST") {
      if (!uid) return jsonRes(401, { error: "unauthorized", message: "LINE認証が必要です。" });
      const methodName = body.method || "liff";
      const member = memberByLine(db, uid);
      if (!member) {
        addLog(db, null, uid, "entry", "denied_unregistered", methodName);
        saveDb(db);
        return jsonRes(403, { error: "unregistered", message: "会員登録がまだです。先に登録してください。" });
      }
      if (member.status !== "active") {
        addLog(db, member.member_id, uid, "entry", "denied_suspended", methodName);
        saveDb(db);
        return jsonRes(403, { error: "suspended", message: "この会員は現在利用停止中です。スタッフにお声がけください。" });
      }
      const cooldown = Number(db.settings.cooldown) || 0;
      const lastSuccess = db.logs
        .filter((l) => l.member_id === member.member_id && l.type === "entry" && l.result === "success")
        .pop();
      if (lastSuccess && cooldown > 0) {
        const elapsed = (new Date() - parseIso(lastSuccess.created_at)) / 1000;
        if (elapsed < cooldown) {
          addLog(db, member.member_id, uid, "entry", "cooldown", methodName);
          saveDb(db);
          return jsonRes(429, { error: "cooldown", message: "解錠済みです。そのままお入りください。" });
        }
      }
      const existing = openStayOf(db, member.member_id);
      if (existing) closeStay(existing, nowIso(), "forced");
      const stay = {
        stay_id: randomId("s_"),
        member_id: member.member_id,
        entry_at: nowIso(),
        exit_at: null,
        exit_method: "open",
        stay_minutes: null,
      };
      db.stays.push(stay);
      addLog(db, member.member_id, uid, "entry", "success", methodName);
      saveDb(db);
      return jsonRes(200, { ok: true, stay_id: stay.stay_id, entry_at: stay.entry_at, unlock_mode: "mock" });
    }

    if (path === "/api/exit" && method === "POST") {
      if (!uid) return jsonRes(401, { error: "unauthorized", message: "LINE認証が必要です。" });
      const member = memberByLine(db, uid);
      if (!member) return jsonRes(403, { error: "unregistered", message: "会員登録がまだです。" });
      const stay = openStayOf(db, member.member_id);
      if (!stay) return jsonRes(404, { error: "not_inside", message: "入室中の記録がありません。" });
      const minutes = closeStay(stay, nowIso(), "actual");
      addLog(db, member.member_id, uid, "exit", "success", "liff");
      saveDb(db);
      return jsonRes(200, { ok: true, stay_minutes: minutes });
    }

    if (path === "/api/rankings" && method === "GET") {
      const period = url.searchParams.get("period") || "month";
      const type = url.searchParams.get("type") || "count";
      const items = computeRankings(db, period, type).slice(0, 10)
        .map((i) => ({ rank: i.rank, name: i.name, count: i.count, minutes: i.minutes }));
      return jsonRes(200, { items: items });
    }

    if (path === "/api/link/nonce" && method === "POST") {
      if (!uid) return jsonRes(401, { error: "unauthorized", message: "LINE認証が必要です。" });
      const member = memberByLine(db, uid);
      if (!member) return jsonRes(403, { error: "unregistered" });
      let nonce = "";
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      for (let i = 0; i < 43; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
      return jsonRes(200, { nonce: nonce, accountLinkUrl: null });
    }

    /* --- 管理者 --- */
    if (path.startsWith("/api/admin/")) {
      const denied = adminGuard();
      if (denied) return denied;

      if (path === "/api/admin/dashboard" && method === "GET") {
        runAutoExit(db);
        const fresh = loadDb();
        const today = todayStr();
        const todayLogs = fresh.logs.filter(
          (l) => l.type === "entry" && l.result === "success" && l.created_at.slice(0, 10) === today
        );
        const unique = new Set(todayLogs.map((l) => l.member_id)).size;
        const inside = fresh.stays
          .filter((s) => s.exit_method === "open")
          .sort((a, b) => (a.entry_at < b.entry_at ? -1 : 1))
          .map((s) => {
            const m = memberById(fresh, s.member_id);
            return { member_id: s.member_id, name: m ? m.name : "", entry_at: s.entry_at };
          });
        const failures = fresh.logs
          .filter((l) => l.type === "entry" && l.result !== "success")
          .slice().reverse().slice(0, 10)
          .map((l) => ({ created_at: l.created_at, line_user_id: l.line_user_id, result: l.result }));
        return jsonRes(200, {
          todayEntries: todayLogs.length,
          todayUniqueUsers: unique,
          currentlyInside: inside,
          recentFailures: failures,
        });
      }

      if (path === "/api/admin/members" && method === "GET") {
        const q = url.searchParams.get("q") || "";
        const items = db.members
          .filter((m) => !q || m.name.includes(q) || m.member_id.includes(q))
          .map((m) => ({
            member_id: m.member_id, line_user_id: m.line_user_id, name: m.name,
            status: m.status, registered_at: m.registered_at,
          }));
        return jsonRes(200, { items: items });
      }

      const detailMatch = path.match(/^\/api\/admin\/members\/([\w-]+)$/);
      if (detailMatch && method === "GET") {
        const member = memberById(db, detailMatch[1]);
        if (!member) return jsonRes(404, { error: "not_found" });
        const history = historyRows(db, { member_id: member.member_id }).slice(0, 50);
        return jsonRes(200, {
          member: {
            member_id: member.member_id, line_user_id: member.line_user_id, name: member.name,
            status: member.status, registered_at: member.registered_at,
          },
          history: history,
        });
      }

      const statusMatch = path.match(/^\/api\/admin\/members\/([\w-]+)\/status$/);
      if (statusMatch && method === "POST") {
        const member = memberById(db, statusMatch[1]);
        if (!member) return jsonRes(404, { error: "not_found" });
        if (!["active", "suspended", "withdrawn"].includes(body.status)) {
          return jsonRes(400, { error: "bad_status" });
        }
        member.status = body.status;
        saveDb(db);
        return jsonRes(200, { ok: true });
      }

      const relinkMatch = path.match(/^\/api\/admin\/members\/([\w-]+)\/relink$/);
      if (relinkMatch && method === "POST") {
        const member = memberById(db, relinkMatch[1]);
        if (!member) return jsonRes(404, { error: "not_found" });
        const newUid = (body.new_line_user_id || "").trim();
        if (!newUid) return jsonRes(400, { error: "new_line_user_id_required" });
        member.line_user_id = newUid;
        saveDb(db);
        return jsonRes(200, { ok: true });
      }

      if (path === "/api/admin/history" && method === "GET") {
        const items = historyRows(db, {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          member_id: url.searchParams.get("member_id"),
          result: url.searchParams.get("result"),
        }).slice(0, 500);
        return jsonRes(200, { items: items });
      }

      if (path === "/api/admin/history.csv" && method === "GET") {
        const text = historyCsv(db, {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          member_id: url.searchParams.get("member_id"),
          result: url.searchParams.get("result"),
        });
        return new Response(text, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } });
      }

      if (path === "/api/admin/rankings" && method === "GET") {
        const items = computeRankings(db, url.searchParams.get("period") || "month", url.searchParams.get("type") || "count");
        return jsonRes(200, { items: items });
      }

      if (path === "/api/admin/rankings.csv" && method === "GET") {
        const text = rankingCsv(db, url.searchParams.get("period") || "month", url.searchParams.get("type") || "count");
        return new Response(text, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } });
      }

      if (path === "/api/admin/settings" && method === "GET") {
        return jsonRes(200, {
          unlock_cooldown_sec: Number(db.settings.cooldown),
          auto_exit_hours: Number(db.settings.autoHours),
        });
      }
      if (path === "/api/admin/settings" && method === "POST") {
        if (body.unlock_cooldown_sec != null) db.settings.cooldown = Number(body.unlock_cooldown_sec);
        if (body.auto_exit_hours != null) db.settings.autoHours = Number(body.auto_exit_hours);
        saveDb(db);
        return jsonRes(200, { ok: true });
      }

      if (path === "/api/admin/run-auto-exit" && method === "POST") {
        const closed = runAutoExit(db);
        return jsonRes(200, { closed: closed });
      }

      if (path === "/api/admin/unlock" && method === "POST") {
        addLog(db, null, uid, "unlock_staff", "success", "admin");
        saveDb(db);
        return jsonRes(200, { ok: true, unlock_mode: "mock" });
      }

      if (path === "/api/admin/integration" && method === "GET") {
        let base = db.settings.baseUrl || "";
        if (!base) base = location.origin + location.pathname.replace(/[^/]*$/, "");
        base = base.replace(/\/$/, "");
        const entry = base + "/";
        return jsonRes(200, {
          base_url: base,
          entry_url: entry,
          exit_url: entry + "?screen=exit",
          switchbot: switchbotState(db),
        });
      }
      if (path === "/api/admin/integration" && method === "POST") {
        db.settings.baseUrl = (body.base_url || "").trim().replace(/\/$/, "");
        saveDb(db);
        return jsonRes(200, { ok: true });
      }

      if (path === "/api/admin/switchbot" && method === "POST") {
        if (body.clear) {
          db.settings.sb = { token: "", secret: "", deviceId: "" };
        } else {
          if ((body.token || "").trim()) db.settings.sb.token = body.token.trim();
          if ((body.secret || "").trim()) db.settings.sb.secret = body.secret.trim();
          if ((body.device_id || "").trim()) db.settings.sb.deviceId = body.device_id.trim();
        }
        saveDb(db);
        return jsonRes(200, { ok: true, switchbot: switchbotState(db) });
      }

      if (path === "/api/admin/switchbot/test" && method === "POST") {
        return jsonRes(200, {
          ok: true,
          devices: [{
            deviceId: "DEMO-LOCK-0001",
            deviceName: "入口ロック（デモ）",
            deviceType: "Smart Lock",
            hubDeviceId: "DEMO-HUB-0001",
          }],
        });
      }

      return jsonRes(404, { error: "not_found" });
    }

    return jsonRes(404, { error: "not_found" });
  }

  /* ---------- fetch 上書き ---------- */
  window.fetch = function (input, options) {
    const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch (e) {
      return originalFetch(input, options);
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.includes("/api/")) {
      return originalFetch(input, options);
    }
    // GitHub Pages のプロジェクトパス配下（/repo/api/...）でも横取りできるよう正規化
    const apiIndex = url.pathname.indexOf("/api/");
    if (apiIndex > 0) {
      url = new URL(url.href);
      url.pathname = url.pathname.slice(apiIndex);
    }
    const opts = options || {};
    if (!options && typeof input === "object" && input !== null) {
      // Request オブジェクトで呼ばれた場合（通常の画面コードでは使わない）
      return originalFetch(input, options);
    }
    try {
      return Promise.resolve(handleApi(url, opts));
    } catch (e) {
      return Promise.resolve(jsonRes(500, { error: "server_error", message: String(e && e.message || e) }));
    }
  };
})();
