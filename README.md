# AI 動態去濕體質檢測系統 (Adaptive AI Dampness Assessment)

本系統是一個基於大型語言模型（LLM）驅動的動態問答系統，模擬真實中醫師的「望聞問切」過程，為使用者進行體質判定（濕熱型、寒濕型、混合型）並給出客製化調理計畫。

## 📍 系統架構與路徑

* **前端介面**: `/public/dampness/index.html`
* **後端 API**: `/src/worker.js` (Endpoint: `/api/dampness-chat`)
* **AI 引擎**: NVIDIA NIM API (使用模型: `google/gemma-3-27b-it`)
* **資料儲存**: 使用現有的 `/api/register` 將使用者的 Email 與體質結果存入 D1 資料庫。

---

## ⚙️ 核心運作邏輯 (Workflow)

不同於傳統的「靜態心理測驗」，本系統採用**狀態保持的動態追問（Adaptive Questionnaire）**機制：

1. **狀態追蹤**: 前端 `index.html` 維護一個 `qaHistory` 陣列，紀錄使用者過去所有的【問題與回答】。
2. **動態生成**: 每次使用者點擊選項後，前端會將完整的 `qaHistory` POST 到 `/api/dampness-chat`。
3. **Prompt 攔截與控制**:
   * **第 1 題**: 系統提示 AI 給出一個廣泛的初始問題（如：最困擾的症狀）。
   * **第 2~9 題**: 系統提示 AI 根據上一題的回答，切換不同「中醫四診維度」（如睡眠、排便、飲食等）進行深度追問。
   * **第 10 題 (Hard Limit)**: 為了避免 AI 無限發問導致體驗不佳，當 `qaHistory.length >= 10` 時，後端會觸發【強制指令】，要求 AI 立即停止發問，並統整前 10 題資訊給出最終診斷。
4. **JSON 結構化輸出**: AI 被嚴格限制只能回傳 JSON 格式。前端根據 `is_final` 屬性決定是要渲染「下一題」還是「最終診斷報告」。

---

## 📄 API 規格 (`/api/dampness-chat`)

### Request
```json
{
  "qa_history": [
    { "q": "您最近最困擾的身體狀況是什麼？", "a": "睡醒仍感疲憊沉重" },
    { "q": "請問您的舌苔狀況如何？", "a": "白厚滑膩" }
  ]
}
```

### Response (若尚未問完)
```json
{
  "is_final": false,
  "question": "請問您對氣溫變化的感受如何？",
  "options": ["非常怕冷", "正常", "怕熱流汗", "忽冷忽熱"]
}
```

### Response (若已達到 10 題，強制結算)
```json
{
  "is_final": true,
  "diagnosis": {
    "type": "寒濕型",
    "reason": [
      "判斷點1：根據舌苔白厚與疲勞，顯示...",
      "判斷點2：..."
    ],
    "core_issues": [
      "脾胃虛寒導致運化不良",
      "水濕停滯引起下肢水腫"
    ],
    "action_plan": [
      { "category": "飲食調理", "content": "建議多吃生薑、忌食生冷瓜果..." },
      { "category": "生活作息", "content": "..." },
      { "category": "居家護理", "content": "..." }
    ],
    "long_term": [
      "階段一 (第1-7天)：溫陽化濕...",
      "階段二 (第8-21天)：健脾益氣...",
      "長期目標：恢復身體輕盈感..."
    ]
  }
}
```

---

## 🎨 前端 UI 渲染機制

* **脈衝載入動畫**: 提問期間顯示 `AI 思考中` 的 Loader，降低使用者等待的焦慮感（Gemma-3-27b 反應時間約 2-4 秒）。
* **UI 預期管理**: 標題顯示 `第 X 題 / 共 10 題`，讓使用者對問卷長度有明確的心理準備。
* **報告視覺化**:
  * **Bullet Points**: `reason` 與 `core_issues` 使用帶有綠色打點的 `.styled-list` 呈現。
  * **Card Grid**: `action_plan` 解析物件，將 `category` 渲染為搶眼的 Badge，提高可讀性。
  * **Timeline**: `long_term` 使用虛線與圓點，渲染成直立式的 21 天調理時間軸。

---

## 🔒 安全性與維護指南

1. **API Key 保護**: NVIDIA NIM API Key (`NVIDIA_API_KEY`) 安全存放在 Cloudflare Secrets 中，切勿在前端直接呼叫 LLM，所有請求必須透過 `worker.js` 代理。
2. **模型抽換**: 目前使用 `google/gemma-3-27b-it`。此模型在「速度」與「中醫辨證準確度（中文語感）」上取得最佳平衡。若未來需要更換模型，請直接修改 `worker.js` 中 `fetch` 的 `body.model` 參數。
3. **防呆機制**: 由於 LLM 偶爾可能產生帶有 Markdown 的 JSON (例如 \`\`\`json ... \`\`\`)，在 `worker.js` 解析前，已有正則表達式 `.replace(/` + "```json" + `/gi, '').replace(/` + "```" + `/g, '')` 進行清理，以確保 `JSON.parse` 不會報錯。
