export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // API: AI 動態去濕問診 (Adaptive Chat)
        if (url.pathname === '/api/dampness-chat' && request.method === 'POST') {
            if (!env.NVIDIA_API_KEY) return new Response(JSON.stringify({ error: 'AI 服務尚未設定' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
            
            let body;
            try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: '格式錯誤' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

            const { qa_history = [] } = body;
            const historyText = qa_history.map(item => `中醫師問：${item.q}\n用戶答：${item.a}`).join('\n\n');
            
            let instruction = '';
            if (qa_history.length === 0) {
                instruction = '這是問診的第一題。請提出一個核心症狀相關的初始問題（例如：您最近最困擾的身體狀況是什麼？），並給出4個具代表性的單選選項。';
            } else if (qa_history.length >= 10) {
                instruction = '【強制指令】你已經收集了 10 題的問診資訊。請「立即」停止發問，綜合以上所有的資訊，強制判定體質並回傳 is_final: true 的最終診斷報告 JSON，確保您的判斷理由具備高度專業說服力。';
            } else {
                instruction = `目前是第 ${qa_history.length + 1} 題。這是一場嚴謹、專業的中醫問診（預計需要 10 題來確保診斷的慎重與準確）。
請根據用戶前一題的回答，切換到另一個中醫四診的觀察維度繼續追問（例如：睡眠品質、排便型態、舌苔口氣、精神狀態、飲食偏好、對天氣變化的反應等），並給出 4 個單選選項。
【重要】請務必繼續提問（回傳 is_final: false），不要太早下結論，必須收集足夠多面向的資訊。`;
            }

            const prompt = `你是一位專業的中醫體質調理師，專精於判斷「濕熱型、寒濕型、混合型」體質。
我們正在對用戶進行線上問診。以下是目前的問診紀錄：

${historyText ? historyText : '（問診剛開始）'}

下一步指示：
${instruction}

【嚴格要求】
你必須只回傳一個合法的 JSON 物件，不要有任何 Markdown (例如 \`\`\`json) 或其他前言後語。請確保 JSON 格式完全正確。

JSON 回傳格式（如果還需要問問題）：
{
  "is_final": false,
  "question": "你的下一個問題",
  "options": ["選項1", "選項2", "選項3", "選項4"]
}

JSON 回傳格式（如果已經可以診斷）：
{
  "is_final": true,
  "diagnosis": {
    "type": "濕熱型",
    "reason": [
      "判斷點1：...",
      "判斷點2：..."
    ],
    "core_issues": [
      "核心問題1",
      "核心問題2"
    ],
    "action_plan": [
      { "category": "飲食調理", "content": "具體建議吃什麼、絕對避開什麼" },
      { "category": "生活作息", "content": "具體的作息或運動建議" },
      { "category": "居家護理", "content": "推薦簡單的穴位按摩、泡腳或茶飲配方" }
    ],
    "long_term": [
      "階段一 (第1-7天)：重點在於...",
      "階段二 (第8-21天)：重點在於...",
      "長期目標：..."
    ]
  }
}`;

            try {
                const nimRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: 'google/gemma-3-27b-it',
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.3,
                        max_tokens: 800,
                    }),
                });

                if (!nimRes.ok) throw new Error(await nimRes.text());
                const nimData = await nimRes.json();
                let content = nimData.choices?.[0]?.message?.content || '';
                
                content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
                return new Response(content, { headers: { 'Content-Type': 'application/json' } });

            } catch (e) {
                console.error('Dampness chat error:', e);
                return new Response(JSON.stringify({ error: 'AI 思考超時或格式錯誤，請重試' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
            }
        }

        // API: Dummy 註冊 Endpoint (為了讓前端 UI 表單正常運作)
        if (url.pathname === '/api/register' && request.method === 'POST') {
            return new Response(JSON.stringify({ success: true, message: 'Dummy API works' }), { headers: { 'Content-Type': 'application/json' } });
        }

        // 若無符合的 API，交由 ASSETS 綁定返回 public 下的靜態資源 (含 index.html)
        return env.ASSETS.fetch(request);
    }
};
