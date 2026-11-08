"use strict";
/* アーベル入退室システム 利用者向けLIFFアプリ
   認証: LIFF時は Authorization: Bearer <IDトークン>
        デモ時は X-Line-User-Id: <localStorageのID> */

const LS_DEMO_USER = "abel_demo_user_id";
const DEFAULT_DEMO_USER = "demo-user-1";

const state = {
  demoMode: false,
  idToken: null, // LIFF IDトークン
  demoUserId: localStorage.getItem(LS_DEMO_USER) || DEFAULT_DEMO_USER,
  me: null,
  rankPeriod: "month",
  rankType: "count",
};

const ERROR_MESSAGES = {
  unregistered: "まだ会員登録ができていません。先に会員登録をしてください。",
  suspended: "現在このアカウントは利用停止中のため、入室できません。運営にお問い合わせください。",
  cooldown: "解錠済みです。少し時間をおいてからお試しください。",
  not_inside: "入室中ではないため、退室できません。",
  unauthorized: "認証できませんでした。LINEから開き直してください。",
  forbidden: "この操作は許可されていません。",
};

const TYPE_LABELS = { entry: "入室", exit: "退室", auto_exit: "自動退室" };
const RESULT_LABELS = {
  success: "成功",
  denied_unregistered: "未登録のため不可",
  denied_suspended: "利用停止のため不可",
  error: "エラー",
};

function $(id) { return document.getElementById(id); }

function showMessage(text, kind) {
  const el = $("message");
  if (!text) { el.className = "message"; el.textContent = ""; return; }
  el.className = "message show " + (kind || "error");
  el.textContent = text;
}

function errorMessage(err) {
  if (err && err.code && ERROR_MESSAGES[err.code]) return ERROR_MESSAGES[err.code];
  if (err && err.code) return "エラーが発生しました（" + err.code + "）。運営にお問い合わせください。";
  return "通信エラーが発生しました。電波の良い場所でもう一度お試しください。";
}

function authHeaders() {
  if (state.idToken) return { Authorization: "Bearer " + state.idToken };
  return { "X-Line-User-Id": state.demoUserId };
}

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, authHeaders(), opts.headers || {});
  if (opts.body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw { code: null, status: 0 };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空レスポンス */ }
  if (!res.ok) {
    throw { code: data && data.error ? data.error : null, status: res.status, data };
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

function fmtMinutes(min) {
  if (min == null) return "—";
  if (min < 60) return min + "分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + "時間" + m + "分" : h + "時間";
}

/* ---------- 初期化 ---------- */
async function init() {
  let config;
  try {
    config = await fetch("/api/config").then((r) => r.json());
  } catch (e) {
    config = { demoMode: true, liffId: null };
  }
  state.demoMode = !!config.demoMode;

  if (config.liffId && window.liff) {
    try {
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      state.idToken = liff.getIDToken();
    } catch (e) {
      state.idToken = null; // 失敗時はデモ扱いにフォールバック
    }
  }

  if (!state.idToken) {
    // デモモード: ユーザーID切替バーを表示
    state.demoMode = true;
    $("demoBar").classList.remove("hidden");
    $("demoUserId").value = state.demoUserId;
  }

  await loadMe();
}

async function loadMe() {
  showMessage("");
  try {
    const me = await api("/api/me");
    state.me = me;
    $("loading").classList.add("hidden");
    if (!me.member) {
      $("registerView").classList.remove("hidden");
      $("mainView").classList.add("hidden");
      return;
    }
    $("registerView").classList.add("hidden");
    $("mainView").classList.remove("hidden");
    renderMe(me);
    await loadRankings();
  } catch (err) {
    $("loading").classList.add("hidden");
    showMessage(errorMessage(err), "error");
  }
}

/* ボタンのローディング表示（解錠など時間がかかる処理用） */
function setBtnLoading(btn, on, loadingText) {
  if (!btn) return;
  const label = btn.querySelector("span");
  // span がない単純なボタンは textContent ごと差し替える（子要素があるボタンでは使わない）
  const plain = !label && btn.children.length === 0;
  if (on) {
    if (label) {
      btn.dataset.label = label.textContent;
      if (loadingText) label.textContent = loadingText;
    } else if (plain) {
      btn.dataset.label = btn.textContent;
      if (loadingText) btn.textContent = loadingText;
    }
    btn.classList.add("is-loading");
    btn.disabled = true;
  } else {
    if (label && btn.dataset.label) label.textContent = btn.dataset.label;
    else if (plain && btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.classList.remove("is-loading");
    btn.disabled = false;
  }
}

function renderMe(me) {
  const evNote = $("eventModeNote");
  if (evNote) {
    evNote.classList.toggle("hidden", !me.eventMode);
  }
  $("memberName").textContent = me.member.name || "";
  const inside = !!me.openStay;
  $("stateText").textContent = inside ? "入室中" : "入室していません";
  $("stateText").classList.toggle("is-in", inside);
  $("stateText").classList.toggle("is-out", !inside);
  $("stateDetail").textContent = inside
    ? "入室時刻: " + fmtDateTime(me.openStay.entry_at)
    : "";
  $("entryBtn").classList.toggle("hidden", inside);
  $("exitBtn").classList.toggle("hidden", !inside);
  // 退室用QR（?screen=exit）から来た場合は退室ボタンを目立たせる
  if (inside && new URLSearchParams(location.search).get("screen") === "exit") {
    $("exitBtn").style.outline = "4px solid #f5a623";
    $("stateText").textContent = "入室中（退室はこちら）";
    $("exitBtn").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (me.myRank) {
    $("rankCount").textContent = me.myRank.count
      ? me.myRank.count.rank + "位（" + me.myRank.count.value + "回）" : "—";
    $("rankDuration").textContent = me.myRank.duration
      ? me.myRank.duration.rank + "位（" + fmtMinutes(me.myRank.duration.value) + "）" : "—";
  }

  const list = $("historyList");
  list.innerHTML = "";
  const history = (me.history || []).slice(0, 20);
  if (!history.length) {
    list.innerHTML = "<li>まだ利用履歴がありません。</li>";
    return;
  }
  for (const h of history) {
    const li = document.createElement("li");
    const type = TYPE_LABELS[h.type] || h.type;
    const result = RESULT_LABELS[h.result] || h.result;
    li.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = "badge" + (h.result === "success" ? "" : " ng");
    badge.textContent = type;
    li.appendChild(badge);
    li.appendChild(document.createTextNode(
      " " + fmtDateTime(h.created_at) + "　" + result));
    list.appendChild(li);
  }
}

/* ---------- ランキング ---------- */
async function loadRankings() {
  const body = $("rankingBody");
  try {
    const data = await api(
      "/api/rankings?period=" + encodeURIComponent(state.rankPeriod) +
      "&type=" + encodeURIComponent(state.rankType));
    body.innerHTML = "";
    const items = (data.items || []).slice(0, 10);
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="4">この期間の利用はまだありません。</td></tr>';
      return;
    }
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = it.rank + "位";
      tr.children[1].textContent = it.name;
      tr.children[2].textContent = it.count + "回";
      tr.children[3].textContent = fmtMinutes(it.minutes);
      body.appendChild(tr);
    }
  } catch (err) {
    body.innerHTML = '<tr><td colspan="4">ランキングを読み込めませんでした。</td></tr>';
  }
}

function bindTabs(containerId, attr, key) {
  $(containerId).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-" + attr + "]");
    if (!btn) return;
    state[key] = btn.dataset[attr];
    for (const b of $(containerId).querySelectorAll("button")) {
      b.classList.toggle("active", b === btn);
    }
    await loadRankings();
  });
}

/* ---------- イベント ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("demoApplyBtn").addEventListener("click", async () => {
    const v = $("demoUserId").value.trim();
    if (!v) { showMessage("デモ用ユーザーIDを入力してください。", "error"); return; }
    state.demoUserId = v;
    localStorage.setItem(LS_DEMO_USER, v);
    $("loading").classList.remove("hidden");
    await loadMe();
  });

  $("registerBtn").addEventListener("click", async () => {
    const name = $("regName").value.trim();
    if (!name) { showMessage("氏名を入力してください。", "error"); return; }
    setBtnLoading($("registerBtn"), true, "登録中…");
    try {
      await api("/api/register", { method: "POST", body: { name } });
      showMessage("会員登録が完了しました。", "ok");
      await loadMe();
    } catch (err) {
      showMessage(errorMessage(err), "error");
    } finally {
      setBtnLoading($("registerBtn"), false);
    }
  });

  $("entryBtn").addEventListener("click", async () => {
    setBtnLoading($("entryBtn"), true, "解錠中…（約5秒かかります）");
    try {
      const r = await api("/api/entry", { method: "POST", body: { method: "liff" } });
      showMessage(
        r.event_mode
          ? "入室を記録しました（イベントモード）。入室時刻: " + fmtDateTime(r.entry_at)
          : "解錠しました。入室時刻: " + fmtDateTime(r.entry_at),
        "ok"
      );
      await loadMe();
    } catch (err) {
      showMessage(errorMessage(err), "error");
    } finally {
      setBtnLoading($("entryBtn"), false);
    }
  });

  $("exitBtn").addEventListener("click", async () => {
    setBtnLoading($("exitBtn"), true, "退室を記録中…");
    try {
      const r = await api("/api/exit", { method: "POST", body: {} });
      showMessage("退室しました。滞在時間: " + fmtMinutes(r.stay_minutes), "ok");
      await loadMe();
    } catch (err) {
      showMessage(errorMessage(err), "error");
    } finally {
      setBtnLoading($("exitBtn"), false);
    }
  });

  bindTabs("periodTabs", "period", "rankPeriod");
  bindTabs("typeTabs", "type", "rankType");

  init();
});
