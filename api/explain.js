// api/explain.js
// サーバー側でだけ動く関数。APIキーはここでしか使わないので、ブラウザに漏れない。
// 1日あたりのIPごとの回数制限つき（お金を守るため）。

// ---- ごく簡単な使用制限（メモリ内。厳密ではないが暴走防止には十分）----
// 二段構え：①1人1日あたり ②全員合わせて1日あたり。
// これに加えて、Anthropic側の残高($19.60)が最終的な壁になる。
const HITS = new Map();          // ip -> { day, count }
const DAILY_LIMIT = 15;          // ①1人1日あたりの上限
const GLOBAL_DAILY_LIMIT = 100;  // ②全員合わせて1日あたりの上限
let GLOBAL = { day: '', count: 0 };

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
// 全体の上限チェック（先に全体、次に個人）
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
const SYSTEMS = {
  chunk: `あなたはプログラミングを初めて学ぶ人に、コードの意味を教えます。
コード全体を受け取り、「意味のまとまり」に区切って、各まとまりが何をするのか説明してください。
【切り方】続きの数行が1つの目的でつながっているなら1つにまとめる。目的が変わったら次のまとまり。1まとまり1〜6行が目安。
【説明】専門用語（関数・非同期・変数・引数・オブジェクト・配列・宣言など）は禁止。必要なら日常語に言い換える。そのまとまりが何をするか、初心者が流れを追えるように2〜4文で説明する。中学生に分かる言葉だけ。前置きなし。
【出力】必ず次のJSONだけを返す。前後に何も付けない。
{"chunks":[{"start":<開始行>,"end":<終了行>,"summary":"<2〜4文の説明>"}]}
行番号は1から。渡した全ての行がいずれかのまとまりに必ず入ること。`,

  line: `プログラミング初心者にコードを教えます。専門用語（関数・非同期・変数・引数・宣言など）禁止。渡された1行について、まずその行の一番キーになる語や記号を1つ選び「〈語〉は『…』という合図です」と言い切り、次にその行が何をするかを1文。その行に無い記号名は出さない。2文まで。前置きなし。`,

  word: `プログラミング初心者に、コードの中の1つの言葉や記号の意味だけを教えます。専門用語で言い換えない。渡された「単語」を、日常の言葉で1文、長くても2文で説明する。前置きなし、説明だけ。`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POSTのみ対応' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'サーバーにAPIキーが設定されていません' }); return; }

  // 使用制限チェック（全体 → 個人 の順）
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
        max_tokens: kind === 'chunk' ? 1600 : 300,
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
