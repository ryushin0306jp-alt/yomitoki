// api/explain.js
// サーバー側でだけ動く関数。APIキーはここでしか使わないので、ブラウザに漏れない。
// 使用制限：①1人1日あたり ②全員合わせて1日あたり。加えてAnthropic側の残高が最終的な壁。

const HITS = new Map();          // ip -> { day, count }
const DAILY_LIMIT = 15;          // ①1人1日あたりの上限
const GLOBAL_DAILY_LIMIT = 100;  // ②全員合わせて1日あたりの上限
let GLOBAL = { day: '', count: 0 };

function today() { return new Date().toISOString().slice(0, 10); }
function overGlobal() {
  const t = today();
  if (GLOBAL.day !== t) { GLOBAL = { day: t, count: 0 }; }
  if (GLOBAL.count >= GLOBAL_DAILY_LIMIT) return true;
  GLOBAL.count++; return false;
}
function overLimit(ip) {
  const t = today();
  const rec = HITS.get(ip);
  if (!rec || rec.day !== t) { HITS.set(ip, { day: t, count: 1 }); return false; }
  if (rec.count >= DAILY_LIMIT) return true;
  rec.count++; return false;
}

// ---- 説明の種類ごとのシステムプロンプト ----
// 方針：分類や正体ではなく「実行したら何が起きるか」。専門用語・比喩・おまじない・擬人化は禁止。
const SYSTEMS = {
  chunk: `コードを読む人に、各まとまりを実行したら何が起きるかを教えます。コード全体を受け取り、「意味のまとまり」に区切って説明してください。
【切り方】続きの数行が1つの目的でつながっているなら1つにまとめる。目的が変わったら次のまとまり。1まとまり1〜6行が目安。
【説明】
- そのまとまりを実行したら「実際に何が起きるか」を言う。分類や正体ではなく、動かした結果。
- 専門用語（処理・宣言・定義・入力・変数・関数・引数・非同期など）は使わない。比喩（箱など）も使わない。
- コード内の名前（generate, transcript 等）をそのまま出さず、それが何かを言葉で言い換える。
- 名前を用意するだけの行（入口など）は「〜する一連の動き」とまとめ、逐語訳しない。
- 各まとまり2〜3文。前置きなし。
【全体総括(overview)】コード全体を実行すると何が起きるかを1〜2文で。分類ではなく実行の結果。専門用語・比喩・コード内の名前をそのまま出すのは避ける。
【出力】必ず次のJSONだけを返す。前後に何も付けない。
{"overview":"<全体の総括1〜2文>","chunks":[{"start":<開始行>,"end":<終了行>,"summary":"<2〜3文>"}]}
行番号は1から。渡した全ての行がいずれかのまとまりに必ず入ること。`,

  line: `コードの1行を実行したら「実際に何が起きるか」を教えます。
- その行を動かした結果（どの値がどうなるか、何が起きるか）を1文で書く。分類や正体ではなく実際の動き。
- 専門用語（処理・宣言・定義・変数・関数・引数・非同期など）は使わない。
- 「おまじない」「魔法の言葉」のような意味をごまかす逃げの表現、「コンピューターが〜と認識する」のような擬人化のセリフも禁止。その言葉が実際に何をするかを正確に言う。
- そのあと、その行でつまずきそうな単語や記号を、多くても2〜3個まで、全角カッコで「（〈語〉 … その言葉が実際に何をするか）」と補足する。無ければ補足なし。
- 前の行で既に出てきた名前は説明を繰り返さない。
- 全体で短く。前置きなし。説明本文だけ。`,

  word: `コードの中の1つの言葉や記号が「実際に何をするか」だけを、短く教えます。
- 1文だけ。長くしない。
- 専門用語で言い換えない（「宣言」「変数」「定義」は禁止）。
- 「おまじない」などの逃げの表現、「コンピューターが〜と認識する」のような擬人化のセリフも禁止。
- その言葉を書くと実際に何が起きるかを簡潔に言い切る。コード内の名前はカギカッコで囲む。
- 前置きなし、説明だけ。`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POSTのみ対応' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'サーバーにAPIキーが設定されていません' }); return; }

  if (overGlobal()) {
    res.status(429).json({ error: '本日の全体のお試し回数が上限に達しました。また明日お試しください。' });
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (overLimit(ip)) {
    res.status(429).json({ error: '本日のあなたのお試し回数が上限に達しました。また明日お試しください。' });
    return;
  }

  try {
    const { kind, prompt } = req.body || {};
    const system = SYSTEMS[kind];
    if (!system || !prompt) { res.status(400).json({ error: 'リクエストの形式が正しくありません' }); return; }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: kind === 'chunk' ? 1800 : 300,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'AIへの問い合わせに失敗しました', detail: t.slice(0, 200) });
      return;
    }
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: 'サーバー内でエラーが発生しました' });
  }
}
