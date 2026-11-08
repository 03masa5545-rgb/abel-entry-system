#!/usr/bin/env python3
"""アーベル入退室システム 起動スクリプト。

使い方:
    cp .env.example .env   # 値を設定（デモ動作だけなら DEMO_MODE=1 のままでOK）
    python3 run.py

- 利用者画面: http://localhost:8000/
- 管理者画面: http://localhost:8000/admin
- デモモードでは X-Line-User-Id ヘッダーでユーザーを識別し、
  管理者は demo-admin として扱う（画面内の入力欄で切り替え可能）。
"""
from backend.server import main

if __name__ == "__main__":
    main()
