# Anim Editor（アニメ編集の単独エディタ化）設計メモ（2026-07-15）

## 動機
本体エディタ（Svelte・最初期設計）はアニメ編集が使いづらい。他のエディタ群（room/bite/furn等）と
同じ「単独ページ・プレーンJS・esm.sh」スタイルで anim-editor/ を新設し、アニメ編集を移す。
本体エディタは当面残す（リターゲット/FBX変換などはそのまま）。

## 構成（anim-editor/ 新規・WebGL）
1. モデル読込: public/vrm manifest から選択＋ローカル.vrmファイル読込
2. ポージング（furn-anim-editorの機構を流用・改良版IK）
   - IKハンドル: 腰(常時ピン留め腰IK+回転)/頭(SpineIK)/左右手/左右足(TwoBoneIK+ポール捕捉)
   - 関節FK: 「関節表示」トグル→主要ボーンに点表示→クリックで回転ギズモ
3. タイムライン（キーフレーム方式）
   - [キー追加]=現在時刻に全正規化ボーン回転+hips位置をベイク
   - キー選択/移動/削除、キー間slerp補間で再生、ループ、長さ/速度
4. VRMA入出力
   - 書き出し: lib/pose-kit buildVrmaBlob → api/save(base64)で public/vrma/ へ＋DLボタン
   - 読み込み: vrma manifest → 8fps均等サンプル(上限120キー)でキー化して再編集
5. hub掲載。furn-anim-editorのF2(タイムライン)はこのエディタで代替可能
   （家具の座標系で作りたい場合は furn 側に後日同タイムラインを移植）

## データモデル
keys: [{ t:秒, pose: {boneName:[x,y,z,w]}, hips:[x,y,z] }] 時刻昇順。
適用=前後キーをslerp/lerp。書き出しは全キー×全ボーンでトラック化（正規化=デルタ変換不要）。
