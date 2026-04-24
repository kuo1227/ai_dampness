export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === '/api/line-webhook' && request.method === 'POST') {
            return handleLineWebhook(request, env, ctx);
        }
        return env.ASSETS.fetch(request);
    }
};

// ─── Webhook Entry ────────────────────────────────────────────────────────────

async function handleLineWebhook(request, env, ctx) {
    const bodyText = await request.text();
    const signature = request.headers.get('x-line-signature');
    const valid = await verifySignature(bodyText, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response('Unauthorized', { status: 401 });

    ctx.waitUntil((async () => {
        try {
            const { events } = JSON.parse(bodyText);
            for (const event of events) {
                if (event.type !== 'message') continue;
                const userId = event.source.userId;
                const replyToken = event.replyToken;

                if (event.message.type === 'text') {
                    const userText = event.message.text.trim();
                    const startKeywords = ['開始檢測', '重新檢測', '檢測', 'start', '開始'];
                    if (startKeywords.includes(userText.toLowerCase())) {
                        await resetSession(userId, env);
                        await sendNextQuestion(userId, [], env, replyToken);
                    } else {
                        await processUserAnswer(userId, userText, env, replyToken);
                    }
                } else if (event.message.type === 'image') {
                    await safeReply(userId, replyToken, [{
                        type: 'text',
                        text: '目前系統為全文字精準問診，不需上傳照片，請直接回答問題即可。'
                    }], env);
                }
            }
        } catch (e) {
            console.error('[Webhook Error]', e.message);
        }
    })());
    return new Response('OK', { status: 200 });
}

// ─── Answer Processing ────────────────────────────────────────────────────────

async function processUserAnswer(userId, answer, env, replyToken) {
    const session = await env.DB.prepare(
        "SELECT * FROM user_sessions WHERE line_user_id = ?"
    ).bind(userId).first();

    if (!session || !session.answers_json) {
        return safeReply(userId, replyToken, [generateWelcomeFlex()], env);
    }

    let history = JSON.parse(session.answers_json);
    if (history.length === 0) {
        return safeReply(userId, replyToken, [generateWelcomeFlex()], env);
    }

    // 使用者主動要求提前結束
    if (answer === '產出報告' || answer === '結束問診') {
        await startLoading(userId, env);
        await resetSession(userId, env);
        try {
            const diag = await generateFinalReport(history, env);
            await saveReport(userId, diag, env);
            await safeReply(userId, replyToken, [
                { type: 'text', text: '正在彙整您的回答，產出濕氣檢測報告...' },
                generateFlexReport(diag)
            ], env);
        } catch (e) {
            console.error('[Early Report Error]', e.message);
            await safeReply(userId, replyToken, [generateFlexReport(normalizeDiagnosis(null))], env);
        }
        return;
    }

    // 記錄使用者對最後一題的回答
    if (history.length > 0 && !history[history.length - 1].a) {
        history[history.length - 1].a = answer;
    }

    await env.DB.prepare(
        "INSERT OR REPLACE INTO user_sessions (line_user_id, answers_json, current_step, last_updated) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
    ).bind(userId, JSON.stringify(history), history.length).run();

    await sendNextQuestion(userId, history, env, replyToken);
}

// ─── Question / Finalization Flow ─────────────────────────────────────────────

async function sendNextQuestion(userId, history, env, replyToken) {
    const stepNum = history.length; // 已完整回答的題數
    const shouldFinalize = stepNum >= 10;

    try {
        if (shouldFinalize) {
            // 先重設 Session，確保任何後續錯誤都不會讓用戶卡住
            await resetSession(userId, env);
            await startLoading(userId, env);

            try {
                const diag = await generateFinalReport(history, env);
                await saveReport(userId, diag, env);
                await safeReply(userId, replyToken, [generateFlexReport(diag)], env);
            } catch (diagErr) {
                console.error('[Final Report Error]', diagErr.message);
                await safeReply(userId, replyToken, [
                    { type: 'text', text: '報告生成稍有延遲，為您提供基礎評估：' },
                    generateFlexReport(normalizeDiagnosis(null))
                ], env);
            }
            return;
        }

        // 問診階段：呼叫 Gemini 取得下一題
        const aiResult = await callGemini(history, false, env);

        // Gemini 判定資訊已足夠，提早結案（需 >= 8 題）
        if (aiResult.is_final === true && stepNum >= 8) {
            await resetSession(userId, env);
            await startLoading(userId, env);
            try {
                // 若 Gemini 在同一次回應中直接給了 diagnosis，直接使用
                const diag = aiResult.diagnosis
                    ? normalizeDiagnosis(aiResult.diagnosis)
                    : await generateFinalReport(history, env);
                await saveReport(userId, diag, env);
                await safeReply(userId, replyToken, [generateFlexReport(diag)], env);
            } catch (e) {
                await safeReply(userId, replyToken, [generateFlexReport(normalizeDiagnosis(null))], env);
            }
            return;
        }

        // 繼續問診
        if (!aiResult.question) throw new Error('Gemini returned no question');

        history.push({ q: aiResult.question, a: null });
        await env.DB.prepare(
            "INSERT OR REPLACE INTO user_sessions (line_user_id, answers_json, current_step, last_updated) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
        ).bind(userId, JSON.stringify(history), history.length).run();

        await safeReply(userId, replyToken, [
            generateQuestionFlex(history.length, aiResult.question, aiResult.options || [])
        ], env);

    } catch (err) {
        console.error('[sendNextQuestion Error]', err.message);
        await safeReply(userId, replyToken, [{
            type: 'text',
            text: '問診系統暫時繁忙，請輸入「開始檢測」重試。'
        }], env);
    }
}

// ─── Gemini API Interface ─────────────────────────────────────────────────────

// V3 System Instruction（來自 PROMPT_GUIDANCE v3.md）
const SYSTEM_INSTRUCTION = `[角色設定]
你是一位擁有 20 年臨床經驗的「專業中醫體質調理師」。你精通人體「濕氣」的辨證論治，能精準區分寒濕、濕熱與痰濕。你的語氣必須親切、溫暖且充滿專業關懷，讓用戶感到安心。

[核心任務]
透過循序漸進的單選題問診，評估用戶的濕氣嚴重程度與體質類型。
為了確保問診全面，請務必依序從以下【問診維度池】中挑選尚未問過的維度進行提問：
(精神狀態、睡眠品質、排便型態、尿液狀態、口氣與味覺、消化與胃口、皮膚與毛髮出油、肢體與關節感受、女性生理/男性精力、體溫與流汗偏好)

[輸出 Schema 規範]
你的輸出必須是純 JSON 物件，絕對不能包含任何 Markdown 標記（如 \`\`\`json）。

若問診未完成（is_final: false）：
{"is_final": false, "question": "親切專業的提問文字", "options": ["選項1（15-25字）", "選項2", "選項3", "選項4"]}

若問診完成（is_final: true）：
{"is_final": true, "diagnosis": {"type": "體質類型（如：濕熱內蘊型）", "severity": 85, "reason": ["症狀分析點1", "症狀分析點2"], "action_plan": [{"category": "日常飲食", "content": "宜吃與忌口清單"}, {"category": "生活作息", "content": "具體作息建議"}, {"category": "穴位按摩", "content": "推薦穴位（位置）與按壓手法"}]}}`;

async function callGemini(history, isFinal, env) {
    const answeredCount = history.filter(h => h.a).length;

    // 依照 V3 規範建構 user content
    let userContent;
    if (answeredCount === 0) {
        userContent = '這是問診的第一題。請針對「早晨起床的精神與身體感受」提出一個核心症狀問題。請提供 4 個具備中醫鑑別度（包含寒熱虛實不同表現）的敘述性單選選項。';
    } else if (isFinal) {
        const historyText = history
            .filter(h => h.a)
            .map((item, i) => `第${i + 1}題：${item.q}\n回答：${item.a}`)
            .join('\n\n');
        userContent = `問診結束。請綜合用戶上述所有回答，進行最終的中醫體質判斷。\n\n${historyText}\n\n根據定義的 Schema 產出完整的 diagnosis 報告，確保 action_plan 具備高度實用性與針對性。請直接輸出 is_final 為 true 的 JSON。`;
    } else {
        const lastItem = history[history.length - 1];
        const userAnswer = lastItem?.a || '';
        const historyText = history
            .filter(h => h.a)
            .map((item, i) => `第${i + 1}題：${item.q}\n回答：${item.a}`)
            .join('\n\n');
        userContent = `目前是第 ${answeredCount + 1} 題。用戶對上一題的回答是：「${userAnswer}」。\n\n已問診紀錄：\n${historyText}\n\n根據此線索，請從【問診維度池】中選擇一個「尚未詢問過」的維度繼續追問。請提供 4 個敘述性單選選項，能進一步區分「寒濕」或「濕熱」。請直接輸出 is_final 為 false 的 JSON。`;
    }

    const model = 'google/gemma-3-27b-it';

    try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTION },
                    { role: 'user', content: userContent }
                ],
                temperature: 0.3,
                max_tokens: 1500
            }),
            signal: AbortSignal.timeout(20000)
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`NVIDIA API ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        if (!content) throw new Error('NVIDIA API returned empty content');

        const f = content.indexOf('{');
        const l = content.lastIndexOf('}');
        if (f === -1 || l === -1) throw new Error('No JSON in response');
        return JSON.parse(content.substring(f, l + 1));

    } catch (err) {
        if (err.name === 'TimeoutError') {
            console.warn(`[NVIDIA Timeout] request timed out`);
        }
        throw err;
    }
}


// 生成最終報告（獨立函數，確保調用時序清晰）
async function generateFinalReport(history, env) {
    const raw = await callGemini(history, true, env);
    // V3 schema 的診斷包在 diagnosis 物件內
    const diagData = raw.diagnosis || raw;
    return normalizeDiagnosis(diagData);
}

// ─── Data Normalization ───────────────────────────────────────────────────────

function normalizeDiagnosis(d) {
    if (!d) return {
        type: "濕氣體質",
        grade: "中度",
        severity: 60,
        reason: ["根據問診表現，身體存在明顯濕氣特徵，建議進行完整調理。"],
        action_plan: [
            { category: "飲食建議", content: "多食薏仁、紅豆、山藥等健脾利濕食材，保持飲食清淡。" },
            { category: "穴位按摩", content: "按摩足三里（膝蓋下三寸外側）、陰陵泉（小腿內側脛骨下緣），各按壓 2 分鐘，促進排濕。" },
            { category: "生活調理", content: "保持規律作息，避免熬夜。適度運動如散步、太極拳以促進氣血循環。" }
        ]
    };

    const type = String(d.type || "濕氣體質");

    // 等級：V3 schema 只有 severity 數值，衍生出文字等級
    const severity = Math.min(100, Math.max(0, parseInt(d.severity) || 60));
    const grade = severity >= 70 ? "嚴重" : severity >= 40 ? "中度" : "輕微";

    let reason = [];
    if (Array.isArray(d.reason)) {
        reason = d.reason.map(r => String(r)).filter(r => r.length > 0);
    } else if (typeof d.reason === 'string' && d.reason.length > 0) {
        reason = d.reason.split(/[。！\n]/).map(s => s.trim()).filter(s => s.length > 0);
    }
    if (reason.length === 0) reason = ["根據問診表現，身體存在明顯濕氣特徵"];

    let action_plan = [];
    if (Array.isArray(d.action_plan)) {
        action_plan = d.action_plan.map(item => {
            if (typeof item === 'object' && item !== null) {
                return { category: String(item.category || "建議"), content: String(item.content || item.description || "") };
            }
            if (typeof item === 'string') {
                const parts = item.split(/[：:]/);
                if (parts.length > 1) return { category: parts[0].trim(), content: parts.slice(1).join('：').trim() };
                return { category: "生活建議", content: item.trim() };
            }
            return null;
        }).filter(i => i !== null && i.content.length > 0);
    }
    if (action_plan.length === 0) {
        action_plan = [{ category: "日常調理", content: "保持飲食清淡，適度排濕運動。" }];
    }

    return { type, grade, severity, reason, action_plan };
}

// ─── Flex Message Generators ──────────────────────────────────────────────────

function generateWelcomeFlex() {
    return {
        type: 'flex', altText: '歡迎使用 AI 濕氣檢測',
        contents: {
            type: 'bubble',
            header: {
                type: 'box', layout: 'vertical', backgroundColor: '#1B1B1B', paddingAll: 'md',
                contents: [{ type: 'text', text: 'AI 中醫濕氣檢測', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }]
            },
            body: {
                type: 'box', layout: 'vertical', paddingAll: 'xl',
                contents: [
                    { type: 'text', text: '您好！我是您的 AI 中醫助手。', weight: 'bold', size: 'md', wrap: true },
                    { type: 'text', text: '我將透過 10 題問診分析您的濕氣體質，並提供個人化調理建議。', size: 'sm', margin: 'md', wrap: true, color: '#666666' }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical',
                contents: [{ type: 'button', action: { type: 'message', label: '開始問診', text: '開始檢測' }, style: 'primary', color: '#1DB446' }]
            }
        }
    };
}

function generateQuestionFlex(step, question, options) {
    // LINE action.label 最長 20 字元
    const safeOptions = options.slice(0, 4).map(opt => ({
        display: String(opt),
        label: String(opt).length > 20 ? String(opt).substring(0, 19) + '…' : String(opt)
    }));

    return {
        type: 'flex', altText: `第 ${step} 題`,
        contents: {
            type: 'bubble',
            body: {
                type: 'box', layout: 'vertical',
                contents: [
                    { type: 'text', text: `STEP ${step} / 10`, size: 'xs', color: '#1DB446', weight: 'bold' },
                    { type: 'text', text: question, weight: 'bold', size: 'md', margin: 'md', wrap: true },
                    { type: 'text', text: '💡 若選項不符，可直接輸入您的症狀。', size: 'xxs', color: '#AAAAAA', margin: 'xs', wrap: true },
                    {
                        type: 'box', layout: 'vertical', margin: 'xl', spacing: 'md',
                        contents: safeOptions.map(opt => ({
                            type: 'box', layout: 'vertical', paddingAll: 'md',
                            backgroundColor: '#F5F5F5', cornerRadius: 'md',
                            action: { type: 'message', label: opt.label, text: opt.display },
                            contents: [{ type: 'text', text: opt.display, wrap: true, align: 'center', size: 'sm', color: '#333333' }]
                        }))
                    }
                ]
            }
        }
    };
}

function generateFlexReport(diag) {
    const severityColor = diag.severity > 70 ? '#FF4B2B' : (diag.severity > 40 ? '#F9D423' : '#1DB446');

    const reasonItems = (diag.reason || []).map(r => ({
        type: 'text', text: `• ${r}`, size: 'sm', wrap: true, color: '#333333'
    }));

    const actionItems = (diag.action_plan || []).map(p => ({
        type: 'box', layout: 'vertical', margin: 'sm',
        contents: [
            { type: 'text', text: p.category, weight: 'bold', size: 'sm', color: '#1DB446' },
            { type: 'text', text: p.content, size: 'sm', wrap: true, margin: 'xs', color: '#555555' }
        ]
    }));

    const progressBar = {
        type: 'box', layout: 'horizontal', margin: 'sm', backgroundColor: '#EEEEEE', height: '8px',
        contents: [
            { type: 'box', layout: 'vertical', flex: diag.severity, backgroundColor: severityColor, contents: [{ type: 'filler' }] },
            { type: 'box', layout: 'vertical', flex: Math.max(1, 100 - diag.severity), contents: [{ type: 'filler' }] }
        ]
    };

    return {
        type: 'flex', altText: '您的濕氣檢測報告',
        contents: {
            type: 'bubble', size: 'giga',
            header: {
                type: 'box', layout: 'vertical', backgroundColor: '#1B1B1B', paddingAll: 'md',
                contents: [{ type: 'text', text: '中醫濕氣檢測報告', weight: 'bold', color: '#FFFFFF', size: 'md', align: 'center' }]
            },
            body: {
                type: 'box', layout: 'vertical', paddingAll: 'xl',
                contents: [
                    { type: 'text', text: '濕氣亞型', size: 'sm', color: '#888888' },
                    { type: 'text', text: diag.type, weight: 'bold', size: 'xl', margin: 'xs', color: '#333333' },
                    { type: 'text', text: '濕氣等級', size: 'sm', color: '#888888', margin: 'lg' },
                    { type: 'text', text: diag.grade, weight: 'bold', size: 'xxl', margin: 'xs', color: severityColor },
                    {
                        type: 'box', layout: 'vertical', margin: 'md',
                        contents: [
                            { type: 'text', text: `濕氣指數：${diag.severity}%`, size: 'xs', color: '#AAAAAA' },
                            progressBar
                        ]
                    },
                    { type: 'separator', margin: 'xl' },
                    { type: 'text', text: '【症狀分析】', weight: 'bold', margin: 'xl', size: 'md' },
                    {
                        type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
                        contents: reasonItems.length > 0 ? reasonItems : [{ type: 'text', text: '綜合評估中', size: 'sm', color: '#888888' }]
                    },
                    { type: 'separator', margin: 'xl' },
                    { type: 'text', text: '【專業建議】', weight: 'bold', margin: 'xl', size: 'md' },
                    {
                        type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm',
                        contents: actionItems.length > 0 ? actionItems : [{ type: 'text', text: '建議諮詢專業中醫師', size: 'sm', color: '#888888' }]
                    }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical',
                contents: [{ type: 'button', action: { type: 'message', label: '重新檢測', text: '重新檢測' }, style: 'primary', color: '#1DB446' }]
            }
        }
    };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function verifySignature(body, signature, secret) {
    if (!signature) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const bytes = new Uint8Array(sig);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary) === signature;
}

async function startLoading(chatId, env) {
    try {
        await fetch('https://api.line.me/v2/bot/chat/loading/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
            body: JSON.stringify({ chatId, loadingSeconds: 30 })
        });
    } catch (e) { console.warn('[Loading Indicator Failed]', e.message); }
}

async function safeReply(userId, replyToken, messages, env) {
    const payload = messages.slice(0, 5);
    try {
        const res = await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
            body: JSON.stringify({ replyToken, messages: payload })
        });
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Reply ${res.status}: ${errBody}`);
        }
    } catch (e) {
        console.warn('[Reply Failed → Push]', e.message);
        await pushMessage(userId, payload, env);
    }
}

async function pushMessage(userId, messages, env) {
    try {
        const res = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
            body: JSON.stringify({ to: userId, messages: messages.slice(0, 5) })
        });
        if (!res.ok) {
            const body = await res.text();
            if (res.status === 429 || body.includes('quota')) {
                console.error('[CRITICAL] LINE Push Quota Exhausted (200 messages/month)!');
            }
            throw new Error(`Push ${res.status}: ${body}`);
        }
    } catch (e) {
        console.error('[Push Failed]', e.message);
    }
}

async function resetSession(userId, env) {
    await env.DB.prepare("DELETE FROM user_sessions WHERE line_user_id = ?").bind(userId).run();
}

async function saveReport(userId, diag, env) {
    await env.DB.prepare(
        "INSERT INTO diagnosis_reports (line_user_id, result_summary, severity_score, full_report_json) VALUES (?, ?, ?, ?)"
    ).bind(userId, diag.type, diag.severity || 0, JSON.stringify(diag)).run();
}
