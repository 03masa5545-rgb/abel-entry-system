"use strict";
/* アーベル入退室システム 管理者画面
   認証: X-Line-User-Id: <管理者ID>（デモでは demo-admin が管理者）
   CSVリンクはヘッダーが付けられないため ?as=<管理者ID> を付けて生成する */

const LS_ADMIN_ID = "abel_admin_id";

const state = {
  adminId: localStorage.getItem(LS_ADMIN_ID) || "demo-admin",
  rankPeriod: "month",
  rankType: "count",
};

const RESULT_LABELS = {
  success: "成功",
  denied_unregistered: "未登録のため不可",
  denied_suspended: "利用停止のため不可",
  error: "エラー",
};
const TYPE_LABELS = { entry: "入室", exit: "退室", auto_exit: "自動退室" };
const METHOD_LABELS = { qr: "QR", nfc: "NFC", richmenu: "リッチメニュー", liff: "LIFF" };
const STATUS_LABELS = { active: "有効", suspended: "停止", withdrawn: "退会" };

function $(id) { return document.getElementById(id); }

function showMessage(text, kind) {
  const el = $("message");
  if (!text) { el.className = "message"; el.textContent = ""; return; }
  el.className = "message show " + (kind || "error");
  el.textContent = text;
}

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({ "X-Line-User-Id": state.adminId }, opts.headers || {});
  if (opts.body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error("通信エラーが発生しました。");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空レスポンス */ }
  if (!res.ok) {
    if (res.status === 403) throw new Error("管理者権限がありません。管理者IDを確認してください。");
    if (res.status === 401) throw new Error("認証できませんでした。管理者IDを確認してください。");
    const code = data && data.error ? data.error : "不明なエラー";
    throw new Error("エラーが発生しました（" + code + "）。");
  }
  return data;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ja-JP");
}
function fmtMinutes(min) {
  if (min == null) return "—";
  if (min < 60) return min + "分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + "時間" + m + "分" : h + "時間";
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- ダッシュボード ---------- */
async function loadDashboard() {
  try {
    const d = await api("/api/admin/dashboard");
    $("todayEntries").textContent = d.todayEntries;
    $("todayUnique").textContent = d.todayUniqueUsers;

    const inside = $("insideList");
    inside.innerHTML = "";
    if (!d.currentlyInside || !d.currentlyInside.length) {
      inside.innerHTML = "<li>現在入室中の人はいません。</li>";
    } else {
      for (const p of d.currentlyInside) {
        const li = document.createElement("li");
        li.textContent = p.name + "（" + p.member_id + "）　入室 " + fmtDateTime(p.entry_at);
        inside.appendChild(li);
      }
    }

    const failures = $("failureList");
    failures.innerHTML = "";
    if (!d.recentFailures || !d.recentFailures.length) {
      failures.innerHTML = "<li>直近の解錠失敗はありません。</li>";
    } else {
      for (const f of d.recentFailures) {
        const li = document.createElement("li");
        const badge = document.createElement("span");
        badge.className = "badge ng";
        badge.textContent = RESULT_LABELS[f.result] || f.result;
        li.appendChild(badge);
        li.appendChild(document.createTextNode(
          " " + fmtDateTime(f.created_at) + "　" + (f.line_user_id || "")));
        failures.appendChild(li);
      }
    }
  } catch (err) {
    showMessage(err.message, "error");
  }
}

/* ---------- 会員一覧 ---------- */
async function loadMembers() {
  const body = $("memberBody");
  try {
    const q = $("memberQuery").value.trim();
    const data = await api("/api/admin/members" + (q ? "?q=" + encodeURIComponent(q) : ""));
    body.innerHTML = "";
    if (!data.items || !data.items.length) {
      body.innerHTML = '<tr><td colspan="6">会員が見つかりません。</td></tr>';
      return;
    }
    for (const m of data.items) {
      const tr = document.createElement("tr");
      const options = ["active", "suspended", "withdrawn"].map((s) =>
        '<option value="' + s + '"' + (m.status === s ? " selected" : "") + ">" +
        STATUS_LABELS[s] + "</option>").join("");
      tr.innerHTML =
        "<td>" + esc(m.member_id) + "</td>" +
        "<td>" + esc(m.name) + "</td>" +
        "<td>" + esc(m.line_user_id) + "</td>" +
        "<td>" + esc(fmtDate(m.registered_at)) + "</td>" +
        "<td>" + (m.linked_at ? esc(fmtDate(m.linked_at)) : "未連携") + "</td>" +
        '<td><select data-member-id="' + esc(m.member_id) + '">' + options + "</select></td>";
      body.appendChild(tr);
    }
    body.querySelectorAll("select[data-member-id]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const memberId = sel.dataset.memberId;
        const status = sel.value;
        sel.disabled = true;
        try {
          await api("/api/admin/members/" + encodeURIComponent(memberId) + "/status",
            { method: "POST", body: { status } });
          showMessage("会員 " + memberId + " のステータスを「" + STATUS_LABELS[status] + "」に変更しました。", "ok");
        } catch (err) {
          showMessage(err.message, "error");
          await loadMembers();
        } finally {
          sel.disabled = false;
        }
      });
    });
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5">読み込めませんでした。</td></tr>';
    showMessage(err.message, "error");
  }
}

/* ---------- 利用歴 ---------- */
function historyQuery() {
  const params = new URLSearchParams();
  const from = $("histFrom").value;
  const to = $("histTo").value;
  const result = $("histResult").value;
  const memberId = $("histMember").value.trim();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (result) params.set("result", result);
  if (memberId) params.set("member_id", memberId);
  return params;
}

function updateCsvLinks() {
  const hp = historyQuery();
  hp.set("as", state.adminId);
  $("histCsvLink").href = "/api/admin/history.csv?" + hp.toString();
  const rp = new URLSearchParams({ period: state.rankPeriod, type: state.rankType, as: state.adminId });
  $("rankCsvLink").href = "/api/admin/rankings.csv?" + rp.toString();
}

async function loadHistory() {
  const body = $("historyBody");
  try {
    const qs = historyQuery().toString();
    const data = await api("/api/admin/history" + (qs ? "?" + qs : ""));
    body.innerHTML = "";
    if (!data.items || !data.items.length) {
      body.innerHTML = '<tr><td colspan="6">条件に合う履歴がありません。</td></tr>';
      return;
    }
    for (const h of data.items) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(fmtDateTime(h.created_at)) + "</td>" +
        "<td>" + esc(h.member_id || "") + "</td>" +
        "<td>" + esc(h.name || "") + "</td>" +
        "<td>" + esc(TYPE_LABELS[h.type] || h.type) + "</td>" +
        "<td>" + esc(RESULT_LABELS[h.result] || h.result) + "</td>" +
        "<td>" + esc(METHOD_LABELS[h.method] || h.method || "") + "</td>";
      body.appendChild(tr);
    }
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6">読み込めませんでした。</td></tr>';
    showMessage(err.message, "error");
  } finally {
    updateCsvLinks();
  }
}

/* ---------- ランキング ---------- */
async function loadRankings() {
  const body = $("rankingBody");
  try {
    const qs = new URLSearchParams({ period: state.rankPeriod, type: state.rankType }).toString();
    const data = await api("/api/admin/rankings?" + qs);
    body.innerHTML = "";
    if (!data.items || !data.items.length) {
      body.innerHTML = '<tr><td colspan="5">この期間の利用はまだありません。</td></tr>';
      return;
    }
    for (const it of data.items) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(it.rank + "位") + "</td>" +
        "<td>" + esc(it.member_id) + "</td>" +
        "<td>" + esc(it.name) + "</td>" +
        "<td>" + esc(it.count + "回") + "</td>" +
        "<td>" + esc(fmtMinutes(it.minutes)) + "</td>";
      body.appendChild(tr);
    }
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5">読み込めませんでした。</td></tr>';
    showMessage(err.message, "error");
  } finally {
    updateCsvLinks();
  }
}

function bindTabs(containerId, attr, key, after) {
  $(containerId).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-" + attr + "]");
    if (!btn) return;
    state[key] = btn.dataset[attr];
    for (const b of $(containerId).querySelectorAll("button")) {
      b.classList.toggle("active", b === btn);
    }
    await after();
  });
}

/* ---------- 初期化 ---------- */
async function loadAll() {
  showMessage("");
  await loadDashboard();
  await loadMembers();
  await loadHistory();
  await loadRankings();
}

document.addEventListener("DOMContentLoaded", () => {
  $("adminId").value = state.adminId;
  $("adminIdNow").textContent = state.adminId;

  $("adminApplyBtn").addEventListener("click", async () => {
    const v = $("adminId").value.trim();
    if (!v) { showMessage("管理者IDを入力してください。", "error"); return; }
    state.adminId = v;
    localStorage.setItem(LS_ADMIN_ID, v);
    $("adminIdNow").textContent = v;
    await loadAll();
  });

  $("refreshDashBtn").addEventListener("click", loadDashboard);
  $("memberSearchBtn").addEventListener("click", loadMembers);
  $("histSearchBtn").addEventListener("click", loadHistory);
  ["histFrom", "histTo", "histResult", "histMember"].forEach((id) => {
    $(id).addEventListener("change", updateCsvLinks);
  });

  $("autoExitBtn").addEventListener("click", async () => {
    const btn = $("autoExitBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = "実行中…";
    try {
      const r = await api("/api/admin/run-auto-exit", { method: "POST", body: {} });
      showMessage("自動退室を実行しました。" + r.closed + " 件を退室扱いにしました。", "ok");
      await loadDashboard();
      await loadHistory();
    } catch (err) {
      showMessage(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.textContent = orig;
    }
  });

  $("unlockBtn").addEventListener("click", async () => {
    const btn = $("unlockBtn");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = "解錠中…";
    try {
      await api("/api/admin/unlock", { method: "POST", body: {} });
      showMessage("遠隔解錠しました。", "ok");
    } catch (err) {
      showMessage(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.textContent = orig;
    }
  });

  bindTabs("rankPeriodTabs", "period", "rankPeriod", loadRankings);
  bindTabs("rankTypeTabs", "type", "rankType", loadRankings);

  loadAll();
});
