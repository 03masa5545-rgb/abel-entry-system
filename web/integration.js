"use strict";
/* 入口素材・連携設定（integration）用スクリプト。
   管理者IDは admin.js と同じ localStorage キー abel_admin_id を使う。 */

const INT_LS_ADMIN = "abel_admin_id";
const intState = { entryUrl: "", exitUrl: "" };

function intAdminId() {
  return localStorage.getItem(INT_LS_ADMIN) || "demo-admin";
}

async function intApi(path, options) {
  const opts = options || {};
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Line-User-Id": intAdminId(),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || ("HTTP " + res.status));
  }
  return data;
}

function intMsg(text) {
  const el = document.getElementById("message");
  if (el) {
    el.textContent = text;
    el.style.display = text ? "block" : "none";
  }
}

function makeQr(elementId, text) {
  const el = document.getElementById(elementId);
  el.innerHTML = "";
  // qrcodejs で 220px のQRを描く
  new QRCode(el, {
    text: text,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function qrCanvas(containerId) {
  return document.querySelector("#" + containerId + " canvas");
}

function downloadPng(containerId, filename) {
  const canvas = qrCanvas(containerId);
  if (!canvas) {
    intMsg("QRがまだ生成されていません");
    return;
  }
  // 印刷用に余白を付けた大きなPNGにする
  const out = document.createElement("canvas");
  const scale = 4;
  const pad = 40;
  out.width = canvas.width * scale + pad * 2;
  out.height = canvas.height * scale + pad * 2;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, pad, pad, canvas.width * scale, canvas.height * scale);
  const a = document.createElement("a");
  a.href = out.toDataURL("image/png");
  a.download = filename;
  a.click();
}

function openPop(containerId, title, subtitle, url) {
  const canvas = qrCanvas(containerId);
  if (!canvas) {
    intMsg("QRがまだ生成されていません");
    return;
  }
  const img = canvas.toDataURL("image/png");
  const w = window.open("", "_blank");
  w.document.write(
    "<!DOCTYPE html><html lang='ja'><head><meta charset='utf-8'><title>" +
      title +
      "</title><style>body{font-family:sans-serif;text-align:center;padding:48px;color:#0679CE}" +
      "h1{font-size:44px;margin:16px 0 4px}p{color:#333;font-size:20px}img{width:420px;height:420px}" +
      ".url{color:#666;font-size:13px;word-break:break-all}</style></head><body>" +
      "<div style='font-size:22px;letter-spacing:.2em'>Avel</div>" +
      "<h1>" + title + "</h1><p>" + subtitle + "</p>" +
      "<img src='" + img + "' alt='QR'>" +
      "<p class='url'>" + url + "</p>" +
      "<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script>" +
      "</body></html>"
  );
  w.document.close();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    intMsg("URLをコピーしました: " + text);
  } catch (e) {
    intMsg("コピーに失敗しました。URLは画面に表示されています。");
  }
}

function renderSwitchbot(sb) {
  const el = document.getElementById("sbStatus");
  if (!sb) {
    el.textContent = "状態を取得できませんでした";
    return;
  }
  if (sb.configured) {
    el.textContent =
      "連携済み（保存先: " + (sb.source === "db" ? "管理者画面で保存" : "環境変数") +
      "、デバイスID: " + sb.device_id_masked + "）";
  } else {
    el.textContent =
      "未設定です（トークン: " + (sb.has_token ? "あり" : "なし") +
      "／シークレット: " + (sb.has_secret ? "あり" : "なし") +
      "）。未設定の間はモック解錠で動作します。";
  }
}

async function loadIntegration() {
  try {
    const data = await intApi("/api/admin/integration");
    document.getElementById("baseUrlInput").value =
      data.base_url && !data.base_url.startsWith("http://localhost") ? data.base_url : "";
    intState.entryUrl = data.entry_url;
    intState.exitUrl = data.exit_url;
    document.getElementById("entryUrlText").textContent = data.entry_url;
    document.getElementById("exitUrlText").textContent = data.exit_url;
    if (window.QRCode) {
      makeQr("qrEntry", data.entry_url);
      makeQr("qrExit", data.exit_url);
    }
    renderSwitchbot(data.switchbot);
  } catch (e) {
    intMsg("連携情報の取得に失敗しました: " + e.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadIntegration();

  document.getElementById("baseUrlSaveBtn").addEventListener("click", async () => {
    try {
      const v = document.getElementById("baseUrlInput").value.trim();
      await intApi("/api/admin/integration", { method: "POST", body: { base_url: v } });
      intMsg("ベースURLを保存しました");
      loadIntegration();
    } catch (e) {
      intMsg("保存に失敗しました: " + e.message);
    }
  });

  document.getElementById("qrEntryPng").addEventListener("click", () =>
    downloadPng("qrEntry", "abel-qr-entry.png")
  );
  document.getElementById("qrExitPng").addEventListener("click", () =>
    downloadPng("qrExit", "abel-qr-exit.png")
  );
  document.getElementById("qrEntryPop").addEventListener("click", () =>
    openPop("qrEntry", "入室はこちら", "LINEで読み取って解錠してください", intState.entryUrl)
  );
  document.getElementById("qrExitPop").addEventListener("click", () =>
    openPop("qrExit", "退室はこちら", "お帰りの際は退室記録をお願いします", intState.exitUrl)
  );
  document.getElementById("copyEntryUrl").addEventListener("click", () => copyText(intState.entryUrl));
  document.getElementById("copyExitUrl").addEventListener("click", () => copyText(intState.exitUrl));

  document.getElementById("sbSaveBtn").addEventListener("click", async () => {
    try {
      const body = {
        token: document.getElementById("sbToken").value.trim(),
        secret: document.getElementById("sbSecret").value.trim(),
        device_id: document.getElementById("sbDevice").value.trim(),
      };
      const r = await intApi("/api/admin/switchbot", { method: "POST", body });
      document.getElementById("sbToken").value = "";
      document.getElementById("sbSecret").value = "";
      document.getElementById("sbDevice").value = "";
      renderSwitchbot(r.switchbot);
      intMsg("SwitchBot連携情報を保存しました");
    } catch (e) {
      intMsg("保存に失敗しました: " + e.message);
    }
  });

  document.getElementById("sbClearBtn").addEventListener("click", async () => {
    try {
      const r = await intApi("/api/admin/switchbot", { method: "POST", body: { clear: true } });
      renderSwitchbot(r.switchbot);
      intMsg("保存した連携情報を消しました（環境変数があればそちらが使われます）");
    } catch (e) {
      intMsg("削除に失敗しました: " + e.message);
    }
  });

  document.getElementById("sbTestBtn").addEventListener("click", async () => {
    const list = document.getElementById("sbTestResult");
    list.innerHTML = "<li>接続中…</li>";
    try {
      const r = await intApi("/api/admin/switchbot/test", { method: "POST", body: {} });
      if (!r.devices || r.devices.length === 0) {
        list.innerHTML = "<li>接続できました。登録デバイスはありませんでした。</li>";
        return;
      }
      list.innerHTML = r.devices
        .map(
          (d) =>
            "<li>" + (d.deviceName || "(名称なし)") + " ／ " + (d.deviceType || "") +
            " ／ ID: " + (d.deviceId || "") + "</li>"
        )
        .join("");
      intMsg("SwitchBotに接続できました。ロックのIDを上の欄に保存してください。");
    } catch (e) {
      list.innerHTML = "<li>接続テストに失敗しました</li>";
      intMsg(e.message);
    }
  });

  const applyBtn = document.getElementById("adminApplyBtn");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => setTimeout(loadIntegration, 100));
  }
});

/* イベントモード（一斉入室対策）: 指定時間の間、解錠せず記録のみで入室できる */
document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("eventModeStatus");
  const startBtn = document.getElementById("eventModeBtn");
  const offBtn = document.getElementById("eventModeOffBtn");
  if (!statusEl || !startBtn || !offBtn) return;

  async function refreshEventStatus() {
    try {
      const d = await intApi("/api/admin/dashboard");
      statusEl.textContent = d.eventMode
        ? "イベントモード中です（" + d.eventModeUntil + " まで）。入室は記録のみで、解錠は行われません。ドアは開けたままにしてください。"
        : "イベントモードはオフです。通常は1人ずつ解錠して入室します。";
    } catch (e) {
      statusEl.textContent = "";
    }
  }

  startBtn.addEventListener("click", async () => {
    try {
      const minutes = parseInt(document.getElementById("eventMinutes").value, 10) || 60;
      const r = await intApi("/api/admin/event-mode", { method: "POST", body: { minutes } });
      intMsg("イベントモードを開始しました（" + r.eventModeUntil + " まで）");
      refreshEventStatus();
    } catch (e) {
      intMsg("イベントモードの開始に失敗しました: " + e.message);
    }
  });

  offBtn.addEventListener("click", async () => {
    try {
      await intApi("/api/admin/event-mode/stop", { method: "POST", body: {} });
      intMsg("イベントモードを終了しました");
      refreshEventStatus();
    } catch (e) {
      intMsg("イベントモードの終了に失敗しました: " + e.message);
    }
  });

  refreshEventStatus();
});
