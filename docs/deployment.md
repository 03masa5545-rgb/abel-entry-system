# 本番運用セットアップ手順

デモ（GitHub Pages／DEMO_MODE）から本番運用へ移すための手順書。
構成は次のとおりで、秘密情報はすべてサーバー上の `.env` と管理画面（DB保存）に置き、
このリポジトリには含めない。

```
利用者のスマホ（LINE内LIFF） ──HTTPS──▶ Caddy（証明書自動） ──▶ python3 run.py（:8000）
LINEプラットフォーム ──Webhook(HTTPS)──▶ 同上
run.py ──SwitchBot API──▶ クラウド ──▶ ハブ（現地） ──BLE──▶ ロック
```

## 0. 必要なもの

- 公開できるHTTPSの受け口：VPS等にドメインを向ける方法（推奨）か、
  現地PC＋Cloudflare Tunnel（固定IP不要・無料）のどちらか
- アーベルの公式LINE（Messaging APIチャネル）
- SwitchBotロック＋**ハブ**（Hub Mini / Hub 2。クラウド経由の解錠に必須。
  ハブが無い場合は先に購入・設置する）
- サーバーに Python 3.10 以上（追加ライブラリは不要）

## 1. サーバーを立てる

```bash
git clone https://github.com/03masa5545-rgb/abel-entry-system.git /opt/abel-entry-system
cd /opt/abel-entry-system
cp .env.example .env   # 次の手順で集めた値を入れる（DEMO_MODE=0 にする）
```

- systemd で常駐させる: `deploy/abel-entry.service` を
  `/etc/systemd/system/` に置き、`systemctl enable --now abel-entry`
- HTTPS化: Caddy を使う場合は `deploy/Caddyfile.example` を参照
  （ドメインを向けるだけで証明書は自動取得）
- 疎通確認: `https://<ドメイン>/healthz` が `{"ok": true, ...}` を返すこと

## 2. LINE側の設定（LINE Developers コンソール）

公式LINEのプロバイダーで Messaging API チャネルを使い、次を設定する。

1. `.env` に入れる値を取得する
   - `LINE_CHANNEL_ID`：チャネルの基本設定にあるチャネルID
   - `LINE_CHANNEL_SECRET`：同じく基本設定のチャネルシークレット
   - `LINE_CHANNEL_ACCESS_TOKEN`：Messaging API設定の
     チャネルアクセストークン（長期）を発行
2. Webhook の設定
   - Webhook URL: `https://<ドメイン>/webhook/line`
   - 「Webhookの利用」をオンにして「検証」で成功すること
3. LIFF の追加（同じチャネルに LIFF アプリを追加）
   - エンドポイントURL: `https://<ドメイン>/`
   - スコープ: `profile` と `openid`
   - 発行された LIFF ID を `.env` の `LIFF_ID` に入れる
   - 管理画面も同じLIFFで開く（エンドポイントは `/admin.html` を直接指定可）
4. リッチメニュー（LINE Official Account Manager）
   - 「入室」ボタン: ポストバック、`action=entry`
   - 「退室」ボタン: ポストバック、`action=exit`
   - ポストバックの応答は Reply で返すためメッセージ通数を消費しない
5. 管理者の登録
   - チャネル基本設定に表示される「あなたのユーザーID」を
     `.env` の `ADMIN_LINE_USER_IDS` に入れる
   - ほかの管理者は、連携後に管理画面の会員一覧で LINEユーザーID を確認して追加する

## 3. SwitchBot側の設定

1. ハブ（Hub Mini / Hub 2）をアーベルのWi-Fiに接続し、ロックと通信できる位置に置く
2. SwitchBotアプリで対象ロックの「クラウドサービス」を有効にする
3. トークン／シークレットの取得: アプリの「プロフィール＞設定」で
   アプリバージョンを10回タップすると開発者オプションが現れ、取得できる
4. 反映方法はどちらか一方
   - `.env` に `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` /
     `SWITCHBOT_LOCK_DEVICE_ID` を入れる
   - または管理画面「入口素材・連携設定」から保存する（DBに保存され、
     以後は画面に再表示されない）
   - ロックのデバイスIDは、管理画面の「接続テスト」で出るデバイス一覧から確認できる

## 4. 起動と受け入れ確認

1. `systemctl restart abel-entry` 後、ログに `[ERROR]` が無いこと
   （`journalctl -u abel-entry -n 50`）
2. チェックリスト
   - [ ] `/healthz` が ok を返す
   - [ ] 公式LINEのリッチメニュー／LIFFからアプリが開き、氏名登録ができる
   - [ ] 入室ボタンで実際の鍵が開く（約5秒）。入室が記録される
   - [ ] 退室ボタンで記録され、滞在時間が出る
   - [ ] リッチメニューの入室・退室（ポストバック）でも記録され、応答が返る
   - [ ] 管理者だけが管理画面に入れる（一般会員では403になる）
   - [ ] 管理画面からCSVがダウンロードできる
   - [ ] 公式LINE連携ボタンから連携でき、会員一覧の連携日時が入る
3. 問題が出たら `docs/spec.md` の仕様と突き合わせて切り分ける

## 5. 日常運用

- **バックアップ**: `data/abel_entry.db` を日次でコピーする
  （例: cron で `cp data/abel_entry.db backup/abel_entry_$(date +\%F).db`。
  WAL運用中はコピー前にチェックポイントされる再起動直後が安全）
- **ログ**: `journalctl -u abel-entry -f`
- **更新**: `git pull` して `systemctl restart abel-entry`
- **自動退室**: 12時間の自動退室はサーバー内蔵バッチが定期実行する（設定不要）

## 6. 鍵が開かないときの確認順序

1. ハブがオンラインか（SwitchBotアプリで確認）。オフラインなら現地の電源・Wi-Fi
2. 対象ロックのクラウドサービスが有効か
3. 管理画面の接続テストでデバイス一覧が出るか（出なければトークン失効・未保存）
4. サーバーのログに SwitchBot API のエラーが出ていないか
5. それでも開かない場合は物理鍵など施設側の予備手段で対応し、原因を切り分ける
   （予備手段の詳細はこのリポジトリには書かない）
