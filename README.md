# 🌀 タイフーンドッジ (Typhoon Dodge)

年を選んで、その年の台風シーズンを**実データ**で再現。
日本列島をドラッグで動かし、台風の核心に触れずにシーズンを生き延びるブラウザゲームです。

## 遊び方

1. 1951年〜最新年の中から年を選ぶ（★は気象庁が命名した顕著な台風がある年）
2. ドラッグ / 矢印キー / WASD で日本列島を動かす
3. 台風の**赤い核心**に日本列島が触れたらゲームオーバー
4. 破線の予報円（24時間先）を見て回避。最後の台風が去ればクリア

## データソース

| データ | 出典 | ライセンス |
|---|---|---|
| 台風経路・番号・国際名 | 気象庁 RSMC Tokyo ベストトラック | 気象庁が公表する観測データ（出典: 気象庁） |
| 地図 | Natural Earth を world-atlas で TopoJSON 化 | Natural Earth はパブリックドメイン / world-atlas は ISC License |

## データの再生成

```bash
python3 tools/build_data.py
```

気象庁ベストトラック（`bst_all.zip`）と world-atlas をダウンロードし、
`data/map.json`・`data/tracks/*.json` を生成します（`tools/.cache/` にキャッシュ）。

## ローカルでの実行

```bash
python3 -m http.server 8000
# http://localhost:8000 を開く
```

## デプロイ

Cloudflare Pages（静的サイト。ビルド不要）:

```bash
npx wrangler pages deploy . --project-name typhoon-dodge
```

## ライセンス

ゲームのコードは MIT License（[LICENSE](LICENSE)）です。
データ自体の権利は各出典に帰属します。上記「データソース」の表をご確認ください。

なお本作品は「日本列島を動かして台風から逃げる」というゲームアイデアを
[typhoon_escape](https://lovewcycle.com/games/others/typhoon-escape.html) から着想を得ていますが、
コード・素材はすべて独自実装であり、実データ（年選択・ベストトラック再現）方式を採用している点が異なります。
