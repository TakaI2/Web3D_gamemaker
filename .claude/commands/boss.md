---
description: ボスキャラクターのJSONデータを生成する。要望を伝えるとvolg_boss.jsonのフォーマットに準拠したJSONを出力する。
---

ユーザーの要望（`$ARGUMENTS`）に基づいて、ボスキャラクターのJSONを生成してください。

## ボスJSONフォーマット仕様

以下の `volg_boss.json` の構造に厳密に準拠すること。

```json
{
  "id": "string          // ボス識別子（スネークケース）",
  "name": "string        // 表示名",
  "stats": {
    "hp": "number        // 総HP（フェーズ境界の設計に合わせること）",
    "speed": "number     // 移動速度（通常60〜120）",
    "scale": "number     // スプライト拡大率（通常2〜5）",
    "damage": "number    // 体当たりダメージ"
  },
  "sprite": {
    "key": "string       // 使用スプライトキー（下記から選択）",
    "tint": "string      // 16進数カラー例: '0xff6666'（省略可）"
  },
  "cutin": {
    "image": "string     // カットイン画像キー（'boss_face' 等）",
    "position": "string  // 'left' または 'right'"
  },
  "phases": [
    {
      "phase": "number          // フェーズ番号（1始まり）",
      "hpRange": "[min, max]    // このフェーズのHP範囲",
      "attackCooldown": "number // 攻撃間隔（秒）",
      "patterns": ["string"]    // 使用する攻撃IDの配列
    }
  ],
  "attacks": [
    {
      "id": "string    // 攻撃ID（patternsから参照）",
      "name": "string  // 攻撃名",
      "type": "string  // 攻撃タイプ（下記から選択）",
      "config": {},    // タイプ別設定（下記参照）",
      "se": {},        // SE設定",
      "speech": null   // または { text, duration, color }"
    }
  ],
  "speeches": {
    "intro": "string",
    "phase2": "string",
    "lowHp": "string",
    "defeat": "string"
  },
  "se": {
    "damage": "string  // ダメージSEキー",
    "defeat": "string  // 撃破SEキー"
  }
}
```

## 使用可能なスプライトキー

| key | 外見イメージ |
|-----|------------|
| `solder` | 兵士系 |
| `vamp1` | 吸血鬼系A |
| `vamp2` | 吸血鬼系B |
| `succubus` | 悪魔系 |
| `mage` | 魔法使い系 |
| `brute` | 野獣・巨漢系 |

## 攻撃タイプと config

### `projectile_radial`（放射弾）
```json
{
  "windupDuration": 1000,
  "windupEffect": "blink_red",
  "projectileCount": 8,
  "projectileType": "arrow",
  "projectileSpeed": 250,
  "damage": 1,
  "angleOffset": 0
}
```

### `projectile_circle`（円形配置弾）
```json
{
  "projectileCount": 12,
  "projectileType": "orb",
  "radius": 120,
  "waitDuration": 1500,
  "projectileSpeed": 150,
  "damage": 1,
  "tint": "0x00ffff"
}
```

### `teleport_dash`（テレポート突進）
```json
{
  "fadeOutDuration": 500,
  "fadeInDuration": 500,
  "teleportDistance": 300,
  "windupDuration": 500,
  "dashSpeed": 400,
  "dashDuration": 1000,
  "damage": 2
}
```

### `ultimate`（必殺技・フェーズ2以降推奨）
```json
{
  "projectileCount": 20,
  "projectileType": "orb",
  "spiralAngleStep": 18,
  "spiralRadiusStep": 10,
  "spiralRadiusStart": 100,
  "spawnInterval": 50,
  "projectileSpeed": 200,
  "damage": 2,
  "tint": "0xff00ff"
}
```
ultimate には `cutin`・`cameraEffects`・`bgmControl` を追加できる：
```json
"cutin": { "enabled": true, "skillName": "技名", "duration": 2500 },
"cameraEffects": {
  "darken": { "enabled": true, "alpha": 0.7, "duration": 300 },
  "flash": { "enabled": true, "duration": 200, "color": [255, 100, 100] }
},
"bgmControl": { "volumeDown": 0.3, "duration": 2000 }
```

### `projectileType` の選択肢
- `"arrow"` — 矢
- `"orb"` — 魔法弾（色変更可）

---

## 生成手順

1. ユーザーの要望からボスのコンセプト・強さ・攻撃スタイルを把握する
2. 上記フォーマットに完全準拠したJSONを生成する
3. フェーズ設計の指針：
   - 2フェーズ構成が標準（HP半分でフェーズ2移行）
   - フェーズ2はクールダウンを短くし ultimate を追加
4. HPは攻撃クールダウンと難易度のバランスを考慮して設定する
5. SEキーは `boss_{id}_{action}` 形式で命名する（例: `boss_dragon_radial`）

## 出力形式

以下をすべて出力すること：

1. **生成したJSON全文**（コードブロック内）
2. **保存先**: `public/assets/bosses/{id}.json`
3. **gameflow.json への追記内容**:
   ```json
   "boss": { "configKey": "{id}", "x": 配置X座標, "y": 配置Y座標 }
   ```
4. **ボスの特徴・攻撃パターンの簡単な説明**（日本語）

---

ユーザー要望: $ARGUMENTS
