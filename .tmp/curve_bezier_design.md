# カーブ・ベジェタンジェント編集 設計

## ゴール
グラフエディタで各キーに in/out タンジェント（ハンドル）を持たせ、ドラッグで曲線を成形。
再生も書き出しもその曲線に一致させる。

## データモデル（追加・既存の値ストアは維持）
チャンネル = 軸単位のスカラー：
- ボーン回転: `b|<bone>|<x|y|z>`（値=Euler度）
- ルート位置: `h||<x|y|z>`（値=m）
- 表情: `e|<expr>`（値=0..1）

タンジェント（補助ストア。既存の Quaternion/Vector3/number 値ストアは触らない）:
```
tangents: Map<channelKey, Map<frame, { inT: number; outT: number; broken: boolean }>>
```
- inT/outT = スロープ（値/フレーム）。未設定キーは Catmull-Rom で自動算出。
- broken=false なら in/out を連動（対称）。

## 補間（純粋関数 curveInterp.ts）
`sampleChannel(sortedKeys: {f,v,inT,outT}[], frame) → v`
- 区間 [k0,k1] を Hermite:
  h(t)= h00*v0 + h10*(dt)*m0out + h01*v1 + h11*(dt)*m1in   (dt=f1-f0, t=(f-f0)/dt)
  （m は「値/フレーム」スロープ。ハンドル長=dt/3 を内部で反映）
- 端点外はクランプ。

自動タンジェント: `autoTangent(vPrev,vCur,vNext,dtPrev,dtNext)` = Catmull-Rom 中心差分。

## 再生 seekToFrame（AnimEditorScene）
- ルート位置: 各成分を sampleChannel → Vector3。
- 表情: sampleChannel。
- ボーン: 各軸 Euler を sampleChannel → Euler('XYZ') → Quaternion。
  （slerp から Euler-Hermite へ。グラフエディタ標準。ジンバルは axis 編集の宿命として許容）
- キーが1個/0個のフォールバックは従来通り。

## 書き出し（ベイク方式でCUBICSPLINE回避）
- download 時に **全フレームを sampleChannel でサンプルして密なリニアキー**を作る。
  → 再生と完全一致。VrmaBuilder は無改造（times/values を受け取るだけ）。
- ボーンは各フレームで Euler→Quaternion、delta 変換は既存経路。

## UI（AnimEditorTimeline カーブモード）
- 曲線は sampleChannel を細かくサンプルした滑らかポリライン。
- キーをクリックで選択 → in/out ハンドル（線＋丸）を表示。丸を縦ドラッグで inT/outT を編集
  （broken でなければ対称。Alt/右で broken）。
- 既存の点ドラッグ（値編集）は継続。範囲平滑化も継続。

## フェーズ
1. curveInterp.ts（純粋サンプラ＋自動タンジェント）＋単体テスト。★今回
2. store に tangents ＋ setTangent/import 対応。
3. グラフ表示を滑らかカーブ＋ハンドル表示・編集に。
4. seekToFrame を cubic に。
5. 書き出しベイク。
各フェーズで typecheck/テスト/ブラウザ確認。
